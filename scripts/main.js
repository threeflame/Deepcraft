// BP/scripts/main.js
import { world, system, ItemStack, EquipmentSlot } from "@minecraft/server";
import { ChestFormData } from "./extensions/forms.js";
import { openMarketMenu, processCommandSell } from "./data/market.js";

// Data Imports
import { CONFIG } from "./config.js";
import { CARD_POOL } from "./data/talents.js";
import { QUEST_POOL } from "./data/quests.js";
import { EQUIPMENT_POOL } from "./data/equipment.js";
import { SKILL_POOL } from "./data/skills.js";
import { MOB_POOL } from "./data/mobs.js";

const COMBAT_LOG_CACHE = new Map();

// --- Initialization ---

world.afterEvents.playerSpawn.subscribe((ev) => {
    try {
        const player = ev.player;
        
        if (!player.getDynamicProperty("deepcraft:active_profile")) {
            initializePlayer(player);
        }

        // コンバットログ処刑 (遅延実行版)
        const logKey = `combat_log:${player.id}`;
        if (world.getDynamicProperty(logKey)) {
            // 1. フラグはすぐ消す（二重処刑防止）
            world.setDynamicProperty(logKey, undefined);
            player.setDynamicProperty("deepcraft:combat_timer", 0);
            
            // 2. アイテム没収はすぐに行う
            const inventory = player.getComponent("inventory").container;
            for (let i = 0; i < inventory.size; i++) inventory.setItem(i, undefined);
            
            const equip = player.getComponent("equippable");
            [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Mainhand, EquipmentSlot.Offhand].forEach(slot => {
                equip.setEquipment(slot, undefined);
            });

            // 3. プレイヤーへの宣告
            player.sendMessage("§c§l[警告] 戦闘中に切断したため、ペナルティとして死亡します...");
            player.playSound("random.anvil_land");

            // 4. ★修正: 3秒後(60tick)に処刑する
            // (ログイン直後のロード無敵時間をやり過ごすため)
            system.runTimeout(() => {
                if (player.isValid()) {
                    player.runCommand("kill @s");
                    player.sendMessage("§c§l-> 処刑されました。(Combat Log Penalty)");
                }
            }, 10);

            return; // 処刑対象ならここで処理終了
        }

        // 通常リセット (処刑対象でない場合のみ)
        const hp = player.getComponent("minecraft:health");
        if (hp) hp.resetToMax();
        
        // Hitbox対策
        system.runTimeout(() => {
            if (player.isValid()) player.triggerEvent("scale_reset");
        }, 2);

    } catch (e) { console.warn("Spawn Error: " + e); }
});

function initializePlayer(player) {
    player.setDynamicProperty("deepcraft:active_profile", 1);
    player.setDynamicProperty("deepcraft:ether", CONFIG.ETHER_BASE);
    player.setDynamicProperty("deepcraft:gold", 0);
    
    // プレイヤーの仮想HP初期化
    player.setDynamicProperty("deepcraft:hp", 100);
    player.setDynamicProperty("deepcraft:max_hp", 100);

    loadProfile(player, 1);
    player.sendMessage("§aDeepCraftシステムを初期化しました。");
}


// --- System Loop (修正版) ---

system.runInterval(() => {
    try {
        // 1. Player Loop
        world.getAllPlayers().forEach(player => {
            try {
                if (!player.isValid()) return;

                // --- (レベル、XP、Ether計算などは変更なし。そのまま残してください) ---
                let level = player.getDynamicProperty("deepcraft:level");
                if (typeof level !== 'number' || level < 1) { level = 1; player.setDynamicProperty("deepcraft:level", 1); }
                let xp = player.getDynamicProperty("deepcraft:xp");
                if (typeof xp !== 'number' || xp < 0) { xp = 0; player.setDynamicProperty("deepcraft:xp", 0); }

                const reqXp = getXpCostForLevel(level);
                const intelligence = player.getDynamicProperty("deepcraft:intelligence") || 0;
                const willpower = player.getDynamicProperty("deepcraft:willpower") || 0;

                const maxEther = Math.floor(CONFIG.ETHER_BASE + (intelligence * CONFIG.ETHER_PER_INT));
                let currentEther = player.getDynamicProperty("deepcraft:ether") || 0;
                const regenRate = CONFIG.ETHER_REGEN_BASE + (willpower * CONFIG.ETHER_REGEN_PER_WILL);
                const tickRegen = regenRate / 10; 
                if (currentEther < maxEther) {
                    currentEther = Math.min(maxEther, currentEther + tickRegen);
                    player.setDynamicProperty("deepcraft:ether", currentEther);
                }
                // -------------------------------------------------------

                // ★コンバットタイマー & データバックアップ処理
                let combatTimer = player.getDynamicProperty("deepcraft:combat_timer") || 0;
                
                if (combatTimer > 0) {
                    combatTimer = Math.max(0, combatTimer - 0.5);
                    player.setDynamicProperty("deepcraft:combat_timer", combatTimer);

                    // 戦闘中は「現在の状況」を常にバックアップする
                    const inventory = player.getComponent("inventory").container;
                    const equip = player.getComponent("equippable");
                    let items = [];

                    // インベントリ保存
                    for (let i = 0; i < inventory.size; i++) {
                        const item = inventory.getItem(i);
                        if (item) items.push(item.clone());
                    }
                    // 装備保存
                    [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Mainhand, EquipmentSlot.Offhand].forEach(slot => {
                        const item = equip.getEquipment(slot);
                        if (item) items.push(item.clone());
                    });

                    // キャッシュに登録 (IDをキーにする)
                    COMBAT_LOG_CACHE.set(player.id, {
                        name: player.name,
                        location: { ...player.location }, // 座標をコピー
                        dimensionId: player.dimension.id,
                        items: items,
                        timestamp: Date.now()
                    });

                } else {
                    // 戦闘が終わったらキャッシュから削除 (メモリ節約)
                    if (COMBAT_LOG_CACHE.has(player.id)) {
                        COMBAT_LOG_CACHE.delete(player.id);
                    }
                }

                // --- (HUD表示などは変更なし。そのまま残してください) ---
                const currentHP = Math.floor(player.getDynamicProperty("deepcraft:hp") || 100);
                const maxHP = Math.floor(player.getDynamicProperty("deepcraft:max_hp") || 100);
                const etherPercent = Math.max(0, Math.min(1, currentEther / maxEther));
                const etherBarLen = 10; 
                const etherFill = Math.ceil(etherPercent * etherBarLen);
                const etherBarDisplay = "§b" + "■".repeat(etherFill) + "§8" + "■".repeat(etherBarLen - etherFill);
                const gold = player.getDynamicProperty("deepcraft:gold") || 0;

                let hudText = `§cHP: ${currentHP}/${maxHP}   ` +
                              `§3Ether: ${etherBarDisplay} ${Math.floor(currentEther)}/${maxEther}\n` +
                              `§eLv.${level}   §fXP:${xp}/${reqXp}   §6${gold} G`;
                
                if (combatTimer > 0) {
                    hudText += `\n§c§l⚔ COMBAT: ${combatTimer.toFixed(1)}s ⚔`;
                }

                player.onScreenDisplay.setActionBar(hudText);

                applyEquipmentPenalties(player);
                applyNumericalPassives(player);
                applyStatsToEntity(player);
                // -------------------------------------------------------

            } catch (e) {}
        });

        // 2. Boss Loop
        try {
            world.getDimension("overworld").getEntities({ tags: ["deepcraft:boss"] }).forEach(boss => {
                updateMobNameTag(boss);
                processBossSkillAI(boss);
            });
        } catch (e) {}

    } catch (e) { console.warn("System Loop Error: " + e); }
}, 10);

function getXpCostForLevel(level) {
    return CONFIG.XP_BASE_COST + (level * CONFIG.XP_LEVEL_MULTIPLIER);
}

// --- Mob & Boss Logic ---

function updateMobNameTag(entity) {
    if (!entity.isValid()) return;

    const current = entity.getDynamicProperty("deepcraft:hp");
    const max = entity.getDynamicProperty("deepcraft:max_hp");
    
    if (current === undefined || max === undefined) return;

    const bossId = entity.getDynamicProperty("deepcraft:boss_id");
    let name = entity.typeId.replace("minecraft:", "");
    if (bossId && MOB_POOL[bossId]) {
        name = MOB_POOL[bossId].name;
    } else {
        name = name.charAt(0).toUpperCase() + name.slice(1);
    }

    const percent = Math.max(0, current / max);
    const barLen = 10;
    const fill = Math.ceil(percent * barLen);
    
    let color = "§a";
    if (percent < 0.5) color = "§e";
    if (percent < 0.2) color = "§c";

    const bar = color + "|".repeat(fill) + "§8" + "|".repeat(barLen - fill);
    entity.nameTag = `${name}\n${bar} §f${Math.ceil(current)}/${max}`;
}

function processBossSkillAI(boss) {
    if (!boss.isValid()) return;
    const bossId = boss.getDynamicProperty("deepcraft:boss_id");
    const bossDef = MOB_POOL[bossId];

    if (bossDef && bossDef.skills && boss.target) {
        bossDef.skills.forEach(skill => {
            if (Math.random() < skill.chance) {
                executeBossSkill(boss, skill);
            }
        });
    }
}

function executeBossSkill(boss, skill) {
    if (skill.msg) {
        boss.dimension.runCommand(`tellraw @a[r=30,x=${boss.location.x},y=${boss.location.y},z=${boss.location.z}] {"rawtext":[{"text":"§e[ボス] ${skill.msg}"}]}`);
    }
    skill.action(boss);
}

// --- Player Skill ---

function executeSkill(player, skillId) {
    const skill = SKILL_POOL[skillId];
    if (!skill) return;

    const cdTag = `cooldown:skill_${skillId}`;
    if (player.hasTag(cdTag)) {
        player.playSound("note.bass");
        player.sendMessage("§cスキルはクールダウン中です！");
        return;
    }

    const manaCost = skill.manaCost || 0;
    let currentEther = player.getDynamicProperty("deepcraft:ether") || 0;
    
    if (currentEther < manaCost) {
        player.playSound("note.bass");
        player.sendMessage(`§cエーテルが足りません！ (§b${Math.floor(currentEther)} §c/ §b${manaCost}§c)`);
        return;
    }

    const success = skill.onUse(player);
    if (success !== false) {
        if (manaCost > 0) {
            player.setDynamicProperty("deepcraft:ether", currentEther - manaCost);
        }
        player.addTag(cdTag);
        system.runTimeout(() => {
            if (player.isValid()) {
                player.removeTag(cdTag);
                player.playSound("random.orb");
                player.sendMessage(`§aスキル準備完了: ${skill.name}`);
            }
        }, skill.cooldown * 20);
    }
}

// --- Core Logic: Stat Calculation ---

function calculateEntityStats(entity) {
    const stats = {
        atk: 0, def: 0, critChance: CONFIG.COMBAT.BASE_CRIT_CHANCE, critMult: CONFIG.COMBAT.BASE_CRIT_MULT,
        speed: 1.0, maxEther: 0, etherRegen: 0, maxHP: 100, evasion: 0,
        // 詳細表示用の内訳リスト
        details: { atk: [], def: [], critChance: [], critMult: [], ether: [], regen: [], speed: [], evasion: [] }
    };
    
    // 内訳記録用ヘルパー
    const addDetail = (key, source, value, isRate = false, isMult = false) => {
        if (value === 0) return;
        let valStr = "";
        if (isMult) valStr = `x${value.toFixed(1)}`;
        else if (isRate) valStr = `${value > 0 ? '+' : ''}${(value*100).toFixed(1)}%`;
        else valStr = `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
        stats.details[key].push(`§7${source}: §f${valStr}`);
    };

    // 基礎値の記録
    addDetail('critChance', '基礎値', CONFIG.COMBAT.BASE_CRIT_CHANCE, true);
    addDetail('critMult', '基礎値', CONFIG.COMBAT.BASE_CRIT_MULT, true);
    addDetail('ether', '基礎値', CONFIG.ETHER_BASE);
    addDetail('regen', '基礎値', CONFIG.ETHER_REGEN_BASE);
    addDetail('speed', '基礎値', 1.0, true);

    if (entity.typeId === "minecraft:player") {
        const str = entity.getDynamicProperty("deepcraft:strength") || 0;
        const fort = entity.getDynamicProperty("deepcraft:fortitude") || 0;
        const agi = entity.getDynamicProperty("deepcraft:agility") || 0;
        const int = entity.getDynamicProperty("deepcraft:intelligence") || 0;
        const will = entity.getDynamicProperty("deepcraft:willpower") || 0;
        const defStat = entity.getDynamicProperty("deepcraft:defense") || 0;
        
        let level = entity.getDynamicProperty("deepcraft:level");
        if (typeof level !== 'number' || level < 1) level = 1;

        const equip = entity.getComponent("equippable");
        const mainHand = equip.getEquipment(EquipmentSlot.Mainhand);
        const equipStats = { atk: 0, def: 0 };
        const weaponDef = getEquipmentStats(mainHand);
        equipStats.atk += weaponDef.atk;
        [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet].forEach(slot => {
            equipStats.def += getEquipmentStats(equip.getEquipment(slot)).def;
        });

        // ATK Calculation
        let atk = level + (str * 0.5) + equipStats.atk;
        addDetail('atk', 'レベル', level);
        addDetail('atk', '筋力(Str)', str * 0.5);
        addDetail('atk', '武器', equipStats.atk);

        if (entity.hasTag("talent:brute_force")) { atk += 2; addDetail('atk', 'Brute Force', 2); }
        
        // 倍率補正
        if (entity.hasTag("talent:glass_cannon")) { atk *= 1.5; addDetail('atk', 'Glass Cannon', 1.5, false, true); }
        if (entity.hasTag("talent:sharp_blade")) { atk *= 1.1; addDetail('atk', 'Sharp Blade', 1.1, false, true); }
        
        const hpProp = entity.getDynamicProperty("deepcraft:hp") || 100;
        const hpMaxProp = entity.getDynamicProperty("deepcraft:max_hp") || 100;
        if (entity.hasTag("talent:berserker") && (hpProp / hpMaxProp < 0.3)) { atk *= 1.5; addDetail('atk', 'Berserker', 1.5, false, true); }
        if (entity.hasTag("talent:assassin") && entity.isSneaking) { atk *= 2.0; addDetail('atk', 'Assassin', 2.0, false, true); }
        
        stats.atk = Math.floor(atk);

        // Crit Calculation
        const agiCrit = agi * 0.001;
        const intCrit = int * 0.0005;
        stats.critChance += agiCrit + intCrit;
        addDetail('critChance', '敏捷(Agi)', agiCrit, true);
        addDetail('critChance', '知性(Int)', intCrit, true);

        if (entity.hasTag("talent:eagle_eye")) { stats.critChance += 0.1; addDetail('critChance', 'Eagle Eye', 0.1, true); }
        
        const strCritMult = str * 0.005;
        stats.critMult += strCritMult;
        addDetail('critMult', '筋力(Str)', strCritMult, true);

        // DEF Calculation
        let def = defStat + (fort * CONFIG.COMBAT.DEFENSE_CONSTANT) + equipStats.def;
        addDetail('def', '防御(Def)', defStat);
        addDetail('def', '不屈(Fort)', fort * CONFIG.COMBAT.DEFENSE_CONSTANT);
        addDetail('def', '防具', equipStats.def);

        if (entity.hasTag("talent:tough_skin")) { def += 2; addDetail('def', 'Tough Skin', 2); }
        if (entity.hasTag("talent:iron_wall")) { def += 5; addDetail('def', 'Iron Wall', 5); }
        if (entity.hasTag("talent:last_stand") && (hpProp / hpMaxProp < 0.3)) { def *= 1.5; addDetail('def', 'Last Stand', 1.5, false, true); }
        stats.def = Math.floor(def);

        // Ether Calculation
        const intEther = int * CONFIG.ETHER_PER_INT;
        stats.maxEther += intEther;
        addDetail('ether', '知性(Int)', intEther);

        const willRegen = will * CONFIG.ETHER_REGEN_PER_WILL;
        stats.etherRegen += willRegen;
        addDetail('regen', '意志(Will)', willRegen);

        // HP Calculation
        let hp = 18 + (fort * 2);
        if (entity.hasTag("talent:vitality_1")) hp += 4;
        if (entity.hasTag("talent:vitality_2")) hp += 10;
        if (entity.hasTag("talent:glass_cannon")) hp = Math.floor(hp * 0.5);
        stats.maxHP = Math.floor(hp);

        // Speed Calculation
        let speedIndex = 10 + Math.floor(agi * 0.2);
        let speedBonus = (Math.floor(agi * 0.2) / 100); // 0.2% per Agi
        addDetail('speed', '敏捷(Agi)', speedBonus, true);

        if (entity.hasTag("talent:swift_1")) { speedIndex += 5; addDetail('speed', 'Swiftness', 0.05, true); }
        if (entity.hasTag("talent:godspeed")) { speedIndex += 15; addDetail('speed', 'Godspeed', 0.15, true); }
        if (entity.hasTag("debuff:heavy_armor")) { speedIndex = Math.max(5, speedIndex - 10); addDetail('speed', '重量過多', -0.1, true); }
        stats.speed = speedIndex * 0.01;

        // Evasion Calculation
        if (entity.hasTag("talent:evasion")) { stats.evasion += 0.15; addDetail('evasion', 'Evasion', 0.15, true); }
        const agiEvasion = agi * 0.001;
        stats.evasion += agiEvasion;
        addDetail('evasion', '敏捷(Agi)', agiEvasion, true);

    } else {
        // Mob
        let maxHP = entity.getDynamicProperty("deepcraft:max_hp");
        if (maxHP === undefined) {
            const bossId = entity.getDynamicProperty("deepcraft:boss_id");
            if (bossId && MOB_POOL[bossId]) {
                maxHP = MOB_POOL[bossId].health;
            } else {
                const hpComp = entity.getComponent("minecraft:health");
                maxHP = hpComp ? hpComp.effectiveMax * 10 : 200; 
            }
            entity.setDynamicProperty("deepcraft:max_hp", maxHP);
            entity.setDynamicProperty("deepcraft:hp", maxHP);
        }
        stats.maxHP = maxHP;
        stats.atk = 50;
        stats.def = 0;
    }
    return stats;
}

// --- Events ---

world.afterEvents.itemUse.subscribe((ev) => {
    const player = ev.source;
    const item = ev.itemStack;
    if (item.typeId === "minecraft:compass") { 
        const combatTimer = player.getDynamicProperty("deepcraft:combat_timer") || 0;
        if (combatTimer > 0) {
            player.playSound("note.bass");
            player.sendMessage(`§c§l戦闘中はメニューを開けません！ (§c${combatTimer.toFixed(1)}s§c)`);
            return;
        }

        openMenuHub(player);
        return;
    }
    
    const customId = item.getDynamicProperty("deepcraft:item_id");
    if (customId) {
        const def = EQUIPMENT_POOL[customId];
        if (def && def.skillId) {
            if (checkReq(player, item).valid) {
                executeSkill(player, def.skillId);
            } else {
                player.playSound("random.break");
                player.sendMessage("§c能力不足のためスキルを発動できません！");
            }
        }
    }
});

function handleChatCommand(player, message) {
    // "!sell 100" -> ["sell", "100"] に分解
    const args = message.substring(1).split(" ");
    const command = args[0].toLowerCase();
    const arg1 = args[1];
    const arg2 = args[2];

    switch (command) {
        // --- 一般プレイヤー用 ---
        case "menu":
            openMenuHub(player);
            break;

        case "market":
            openMarketMenu(player);
            break;

        case "sell":
            if (!arg1) {
                player.sendMessage("§c使用法: !sell <価格>");
                return;
            }
            processCommandSell(player, arg1);
            break;

        case "party":
            player.sendMessage("§7パーティ機能は準備中です。");
            break;

        case "help":
            player.sendMessage("§e--- DeepCraft Commands ---");
            player.sendMessage("§f!menu  : メニューを開く");
            player.sendMessage("§f!market: マーケットを開く");
            player.sendMessage("§f!sell <価格>: 手持ちアイテムを出品");
            player.sendMessage("§f!help  : コマンド一覧");
            if (player.hasTag("admin")) {
                player.sendMessage("§c!admin : 管理者メニュー (xp, give, summon, max, reset, quest)");
            }
            break;

        // --- 管理者用 (adminタグ必須) ---
        case "admin":
            if (!player.hasTag("admin")) {
                player.sendMessage("§c権限がありません。(adminタグが必要です)");
                return;
            }
            handleAdminCommand(player, args);
            break;

        default:
            player.sendMessage(`§c不明なコマンドです: ${command}`);
            break;
    }
}

// 管理者コマンドの処理
function handleAdminCommand(player, args) {
    const sub = args[1]; // xp, give, etc.
    const val = args[2]; // 数値やID

    switch (sub) {
        case "xp": // !admin xp 1000
            addXP(player, parseInt(val) || 1000);
            break;
        case "give": // !admin give titan_axe
            if (val) giveCustomItem(player, val);
            else player.sendMessage("§cIDを指定してください");
            break;
        case "summon": // !admin summon bandit_leader
            if (val) summonBoss(player, val);
            else player.sendMessage("§cBossIDを指定してください");
            break;
        case "quest": // !admin quest hunt_zombies
            if (val) acceptQuest(player, val);
            else player.sendMessage("§cQuestIDを指定してください");
            break;
        case "max": // !admin max
            for (const key in CONFIG.STATS) player.setDynamicProperty(`deepcraft:${key}`, 100);
            player.setDynamicProperty("deepcraft:level", 100);
            player.setDynamicProperty("deepcraft:ether", 1000);
            applyStatsToEntity(player);
            player.sendMessage("§e§l[DEBUG] 全ステータス最大化！");
            break;
        case "reset": // !admin reset
            resetCurrentProfile(player);
            break;
        default:
            player.sendMessage("§c使用法: !admin <xp/give/summon/quest/max/reset> [値]");
            break;
    }
}

// ==========================================
//  ⚔️ Modified Combat Logic
//  (No Reset, No Cooldown)
// ==========================================

// --- Combat Logic ---

world.afterEvents.entityHurt.subscribe((ev) => {
    try {
        const victim = ev.hurtEntity;
        const attacker = ev.damageSource.damagingEntity;
        const damageAmount = ev.damage;
        const cause = ev.damageSource.cause;

        // ★修正: システムキルや自殺の場合は処理しない (コンバットループ防止)
        if (damageAmount >= 9999 || cause === "suicide" || cause === "override" || cause === "void") return;

        // コンバットモード開始判定
        // (キルコマンド以外でのダメージのみ反応する)
        if (victim.typeId === "minecraft:player") {
            victim.setDynamicProperty("deepcraft:combat_timer", CONFIG.COMBAT.COMBAT_MODE_DURATION);
            // 音はうるさすぎないように調整
            // victim.playSound("random.click", { pitch: 0.5, volume: 0.5 }); 
        }
        if (attacker && attacker.typeId === "minecraft:player") {
            attacker.setDynamicProperty("deepcraft:combat_timer", CONFIG.COMBAT.COMBAT_MODE_DURATION);
        }

        // 1. ステータス計算
        const victimStats = calculateEntityStats(victim);
        let finalDamage = 0;
        let isCritical = false;

        // A. 攻撃側
        if (attacker && attacker.typeId === "minecraft:player") {
            const attackerStats = calculateEntityStats(attacker);
            const equipment = attacker.getComponent("equippable");
            const mainHand = equipment.getEquipment(EquipmentSlot.Mainhand);
            
            if (!checkReq(attacker, mainHand).valid) {
                attacker.playSound("random.break");
                finalDamage = 1; 
            } else {
                let attack = attackerStats.atk;
                if (Math.random() < attackerStats.critChance) {
                    isCritical = true;
                    attack *= attackerStats.critMult;
                }
                finalDamage = attack;
            }
            
            if (attacker.hasTag("talent:vampirism")) {
                const cur = attacker.getDynamicProperty("deepcraft:hp") || 100;
                const max = attacker.getDynamicProperty("deepcraft:max_hp") || 100;
                attacker.setDynamicProperty("deepcraft:hp", Math.min(cur + 2, max));
            }
        } else {
            // Mob攻撃
            finalDamage = damageAmount; 
        }

        // B. 防御側
        if (victim.typeId === "minecraft:player") {
            let evasionChance = 0;
            if (victim.hasTag("talent:evasion")) evasionChance += 0.15;
            evasionChance += ((victim.getDynamicProperty("deepcraft:agility")||0) * 0.001);

            if (Math.random() < evasionChance) {
                victim.playSound("random.orb");
                victim.sendMessage("§a回避！");
                return;
            }
        }

        finalDamage = Math.max(1, finalDamage - victimStats.def);
        finalDamage = Math.floor(finalDamage);

        // 2. 仮想HPへの適用
        const currentHP = victim.getDynamicProperty("deepcraft:hp");
        const actualCurrentHP = (currentHP !== undefined) ? currentHP : victimStats.maxHP;
        const newHP = actualCurrentHP - finalDamage;
        
        victim.setDynamicProperty("deepcraft:hp", newHP);

        if (victim.typeId !== "minecraft:player") {
            updateMobNameTag(victim);
        }

        // 3. 死亡判定
        if (newHP <= 0) {
            victim.runCommand("kill @s");
            return;
        }

        // 4. 反射
        if (attacker) {
            if (victim.hasTag("talent:thorns_aura")) {
                 const attCur = attacker.getDynamicProperty("deepcraft:hp") || 100;
                 attacker.setDynamicProperty("deepcraft:hp", Math.max(0, attCur - 2));
            }
            if (victim.hasTag("talent:thorns_master")) {
                 const attCur = attacker.getDynamicProperty("deepcraft:hp") || 100;
                 attacker.setDynamicProperty("deepcraft:hp", Math.max(0, attCur - Math.floor(finalDamage * 0.3)));
            }
        }

        // 5. クリティカル演出
        if (isCritical) {
            victim.dimension.playSound("random.anvil_land", victim.location, { pitch: 2.0 });
            victim.dimension.spawnParticle("minecraft:critical_hit_emitter", { x: victim.location.x, y: victim.location.y + 1, z: victim.location.z });
            if (attacker && attacker.typeId === "minecraft:player") {
                attacker.sendMessage(`§c§lクリティカル！ §r§6${finalDamage} ダメージ`);
            }
        }

    } catch (e) {
        console.warn("Combat Error: " + e);
    }
});

// --- Helper Functions ---

function applyStatsToEntity(player) {
    const stats = calculateEntityStats(player);
    player.setDynamicProperty("deepcraft:max_hp", stats.maxHP);
    
    const current = player.getDynamicProperty("deepcraft:hp");
    if (current === undefined || current > stats.maxHP) {
        player.setDynamicProperty("deepcraft:hp", stats.maxHP);
    }

    if (player.hasTag("talent:heavy_stance")) player.triggerEvent("knockback_resistance100");
    else player.triggerEvent("knockback_resistance_reset");

    let speedIndex = Math.floor(stats.speed * 100); 
    speedIndex = Math.min(Math.max(speedIndex, 0), 300);
    player.triggerEvent(`movement${speedIndex}`);
    player.triggerEvent("attack1");
}

function getEquipmentStats(itemStack) {
    if (!itemStack) return { atk: 0, def: 0 };
    const id = itemStack.getDynamicProperty("deepcraft:item_id");
    if (!id) return { atk: 0, def: 0 };
    const def = EQUIPMENT_POOL[id];
    if (!def || !def.stats) return { atk: 0, def: 0 };
    return def.stats;
}

// --- Entity Death (修正版: Soul生成の安定化) ---

world.afterEvents.entityDie.subscribe((ev) => {
    try {
        const victim = ev.deadEntity;
        const attacker = ev.damageSource.damagingEntity;

        // (攻撃者の報酬処理などは変更なし)
        if (attacker && attacker.typeId === "minecraft:player") {
            const questData = JSON.parse(attacker.getDynamicProperty("deepcraft:quest_data") || "{}");
            for (const qId in questData) {
                const q = questData[qId];
                const def = QUEST_POOL[qId];
                if (q.status === "active" && def.type === "kill" && def.target === victim.typeId) {
                    q.progress++;
                    if (q.progress >= def.amount) {
                        q.status = "completed";
                        attacker.playSound("random.levelup");
                        attacker.sendMessage(`§aクエスト完了: ${def.name}`);
                    }
                    attacker.setDynamicProperty("deepcraft:quest_data", JSON.stringify(questData));
                }
            }
            
            if (victim.hasTag("deepcraft:boss")) {
                const bossId = victim.getDynamicProperty("deepcraft:boss_id");
                const def = MOB_POOL[bossId];
                if (def && def.drops) {
                    def.drops.forEach(drop => {
                        if (drop.chance && Math.random() > drop.chance) return;
                        if (drop.type === "xp") {
                            addXP(attacker, drop.amount);
                            attacker.sendMessage(`§eボス撃破！ +${drop.amount} XP`);
                        }
                        if (drop.type === "item") {
                            const itemDef = EQUIPMENT_POOL[drop.id];
                            if (itemDef) {
                                const item = new ItemStack(itemDef.baseItem, 1);
                                item.nameTag = itemDef.name;
                                item.setLore(itemDef.lore);
                                item.setDynamicProperty("deepcraft:item_id", drop.id);
                                attacker.dimension.spawnItem(item, victim.location);
                                attacker.sendMessage(`§6§lレアドロップ！ §r獲得: ${itemDef.name}`);
                            }
                        }
                    });
                }
            }
            if (attacker.hasTag("talent:exp_boost")) addXP(attacker, 50);
        }

        // プレイヤー死亡時の処理 (部分ドロップ)
        if (victim.typeId === "minecraft:player") {
            const player = victim;
            
            player.setDynamicProperty("deepcraft:combat_timer", 0);
            player.setDynamicProperty("deepcraft:hp", player.getDynamicProperty("deepcraft:max_hp"));

            const lostXP = player.getDynamicProperty("deepcraft:xp") || 0;
            player.setDynamicProperty("deepcraft:xp", 0);
            if (lostXP > 0) player.sendMessage(`§c死亡により ${lostXP} XPを失いました...`);

            const inventory = player.getComponent("inventory").container;
            const location = player.location;
            let droppedItems = [];
            
            // ★修正: インベントリ(スロット9以降)のみを対象に抽選ドロップ
            // 0-8(ホットバー)はループ対象外なので確実に残る
            for (let i = 9; i < inventory.size; i++) {
                const item = inventory.getItem(i);
                if (item) {
                    // ドロップ判定 (CONFIGで設定した確率、例:0.5)
                    if (Math.random() < CONFIG.DEATH_ITEM_DROP_RATE) {
                        droppedItems.push(item.clone());
                        inventory.setItem(i, undefined); // インベントリから消す(Soulへ移動)
                    }
                    // 外れたら何もしない(インベントリに残る)
                }
            }

            if (droppedItems.length > 0) {
                try {
                    const spawnLoc = { x: location.x, y: location.y + 1.0, z: location.z };
                    const soul = player.dimension.spawnEntity("minecraft:chest_minecart", spawnLoc);
                    soul.nameTag = `§b${player.name}の魂`;
                    soul.setDynamicProperty("deepcraft:owner_id", player.id);

                    const soulContainer = soul.getComponent("inventory").container;
                    droppedItems.forEach(item => soulContainer.addItem(item));
                    player.sendMessage(`§b一部のアイテムを魂として座標 [${Math.floor(spawnLoc.x)}, ${Math.floor(spawnLoc.y)}, ${Math.floor(spawnLoc.z)}] に落としました。`);
                } catch (e) {}
            }
        }
    } catch(e) { console.warn(e); }
});

function acceptQuest(player, questId) {
    const def = QUEST_POOL[questId];
    if (!def) { player.sendMessage(`§cクエストが見つかりません: ${questId}`); return; }
    const questData = JSON.parse(player.getDynamicProperty("deepcraft:quest_data") || "{}");
    if (questData[questId]) { player.sendMessage("§c既に受注済みか完了しています。"); return; }
    questData[questId] = { status: "active", progress: 0 };
    player.setDynamicProperty("deepcraft:quest_data", JSON.stringify(questData));
    player.sendMessage(`§aクエスト受注: ${def.name}`);
}

function claimQuestReward(player, questId) {
    const def = QUEST_POOL[questId];
    const questData = JSON.parse(player.getDynamicProperty("deepcraft:quest_data") || "{}");
    if (!questData[questId] || questData[questId].status !== "completed") return;
    
    if (def.reward.xp) addXP(player, def.reward.xp);
    if (def.reward.item) {
        const item = new ItemStack(def.reward.item, def.reward.count || 1);
        player.getComponent("inventory").container.addItem(item);
    }
    questData[questId].status = "claimed";
    player.setDynamicProperty("deepcraft:quest_data", JSON.stringify(questData));
    player.playSound("random.levelup");
    player.sendMessage("§6報酬を受け取りました！");
    openQuestMenu(player);
}

function giveCustomItem(player, itemId) {
    const def = EQUIPMENT_POOL[itemId];
    if (!def) { player.sendMessage(`§cアイテムが見つかりません: ${itemId}`); return; }
    const item = new ItemStack(def.baseItem, 1);
    item.nameTag = def.name;
    item.setLore(def.lore);
    item.setDynamicProperty("deepcraft:item_id", itemId);
    player.getComponent("inventory").container.addItem(item);
    player.sendMessage(`§e入手: ${def.name}`);
}

function summonBoss(player, bossId) {
    const def = MOB_POOL[bossId];
    if (!def) { player.sendMessage(`§cボスIDが見つかりません。`); return; }
    try {
        const boss = player.dimension.spawnEntity(def.type, player.location);
        boss.addTag("deepcraft:boss");
        boss.setDynamicProperty("deepcraft:boss_id", bossId);
        boss.nameTag = def.name;
        
        const hp = boss.getComponent("minecraft:health");
        if (hp) boss.addEffect("resistance", 20000000, { amplifier: 1, showParticles: false });
        
        const equip = boss.getComponent("equippable");
        if (equip && def.equipment) {
            if (def.equipment.mainhand) equip.setEquipment(EquipmentSlot.Mainhand, createCustomItem(def.equipment.mainhand));
            if (def.equipment.head) equip.setEquipment(EquipmentSlot.Head, new ItemStack(def.equipment.head));
            if (def.equipment.chest) equip.setEquipment(EquipmentSlot.Chest, new ItemStack(def.equipment.chest));
            if (def.equipment.legs) equip.setEquipment(EquipmentSlot.Legs, new ItemStack(def.equipment.legs));
            if (def.equipment.feet) equip.setEquipment(EquipmentSlot.Feet, new ItemStack(def.equipment.feet));
        }
        if (def.speed) {
            const movement = boss.getComponent("minecraft:movement");
            if (movement) movement.setCurrentValue(def.speed);
        }
        player.sendMessage(`§c§l警告: ${def.name} が出現しました！`);
        player.playSound("mob.enderdragon.growl");
    } catch (e) { player.sendMessage(`§cエラー: ${e}`); }
}

function createCustomItem(itemId) {
    const def = EQUIPMENT_POOL[itemId];
    if (def) {
        const item = new ItemStack(def.baseItem, 1);
        item.nameTag = def.name;
        item.setLore(def.lore);
        item.setDynamicProperty("deepcraft:item_id", itemId);
        return item;
    }
    return new ItemStack(itemId, 1);
}

function addXP(player, amount) {
    let currentXP = player.getDynamicProperty("deepcraft:xp") || 0;
    player.setDynamicProperty("deepcraft:xp", currentXP + amount);
    player.sendMessage(`§e+${amount} XP`);
}

function applyNumericalPassives(player) {
    const hp = player.getComponent("minecraft:health");
    let regenAmount = 0;
    if (player.hasTag("talent:immortal")) regenAmount += 1;
    
    const headBlock = player.dimension.getBlock(player.getHeadLocation());
    if (player.hasTag("talent:aquatic_life") && headBlock && (headBlock.typeId === "minecraft:water" || headBlock.typeId === "minecraft:flowing_water")) {
        regenAmount += 1;
    }

    if (regenAmount > 0) {
        const cur = player.getDynamicProperty("deepcraft:hp") || 0;
        const max = player.getDynamicProperty("deepcraft:max_hp") || 100;
        if (cur < max) player.setDynamicProperty("deepcraft:hp", Math.min(cur + regenAmount, max));
    }

    if (player.hasTag("talent:full_belly")) {
        player.runCommand("effect @s saturation 1 0 true"); 
    }
}

function applyEquipmentPenalties(player) {
    const equipment = player.getComponent("equippable");
    let armorPenalty = false;
    
    [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet].forEach(slot => {
        if (!checkReq(player, equipment.getEquipment(slot)).valid) armorPenalty = true;
    });

    if (armorPenalty) player.addTag("debuff:heavy_armor");
    else player.removeTag("debuff:heavy_armor");
}

function checkReq(player, item) {
    if (!item) return { valid: true };
    const customId = item.getDynamicProperty("deepcraft:item_id");
    if (!customId) return { valid: true };
    const def = EQUIPMENT_POOL[customId];
    if (!def) return { valid: true };

    for (const stat in def.req) {
        const required = def.req[stat];
        const current = player.getDynamicProperty(`deepcraft:${stat}`) || 0;
        if (current < required) return { valid: false, missing: `${CONFIG.STATS[stat]} ${required}` };
    }
    return { valid: true };
}

function saveProfile(player, slot) {
    const questDataStr = player.getDynamicProperty("deepcraft:quest_data") || "{}";
    const data = {
        level: player.getDynamicProperty("deepcraft:level") || 1,
        xp: player.getDynamicProperty("deepcraft:xp") || 0,
        invested_points: player.getDynamicProperty("deepcraft:invested_points") || 0,
        pending_card_draws: player.getDynamicProperty("deepcraft:pending_card_draws") || 0,
        ether: player.getDynamicProperty("deepcraft:ether") || CONFIG.ETHER_BASE,
        stats: {}, talents: [], quests: JSON.parse(questDataStr)
    };
    for (const key in CONFIG.STATS) data.stats[key] = player.getDynamicProperty(`deepcraft:${key}`) || 0;
    player.getTags().forEach(tag => { if (tag.startsWith("talent:")) data.talents.push(tag); });
    player.setDynamicProperty(`deepcraft:profile_${slot}`, JSON.stringify(data));
}

function loadProfile(player, slot) {
    const json = player.getDynamicProperty(`deepcraft:profile_${slot}`);
    let data;
    if (json) {
        data = JSON.parse(json);
    } else {
        data = { level: 1, xp: 0, invested_points: 0, pending_card_draws: 0, ether: CONFIG.ETHER_BASE, stats: {}, talents: [], quests: {} };
        for (const key in CONFIG.STATS) data.stats[key] = 0;
    }
    player.setDynamicProperty("deepcraft:level", data.level);
    player.setDynamicProperty("deepcraft:xp", data.xp);
    player.setDynamicProperty("deepcraft:invested_points", data.invested_points);
    player.setDynamicProperty("deepcraft:pending_card_draws", data.pending_card_draws);
    player.setDynamicProperty("deepcraft:quest_data", JSON.stringify(data.quests || {}));
    player.setDynamicProperty("deepcraft:ether", data.ether || CONFIG.ETHER_BASE);

    for (const key in CONFIG.STATS) player.setDynamicProperty(`deepcraft:${key}`, data.stats[key] || 0);
    player.getTags().forEach(tag => { if (tag.startsWith("talent:")) player.removeTag(tag); });
    data.talents.forEach(tag => player.addTag(tag));
    player.setDynamicProperty("deepcraft:active_profile", slot);
    applyStatsToEntity(player);
    const stats = calculateEntityStats(player);
    player.setDynamicProperty("deepcraft:hp", stats.maxHP);
}

function openMenuHub(player) {
    const form = new ChestFormData("small");
    form.title("§lメニューハブ");
    const pendingDraws = player.getDynamicProperty("deepcraft:pending_card_draws") || 0;
    const activeProfile = player.getDynamicProperty("deepcraft:active_profile") || 1;
    const gold = player.getDynamicProperty("deepcraft:gold") || 0;

    form.button(2, "§b§lタレント確認", ["§r§7所有タレントを見る"], "minecraft:enchanted_book");
    if (pendingDraws > 0) {
        form.button(4, "§6§l🎁 タレントを引く", ["§r§e未受取のタレントがあります！", "§cクリックで抽選", "§8(ステータス画面はロック中)"], "minecraft:nether_star", pendingDraws, 0, true);
    } else {
        form.button(4, "§a§lステータス強化", ["§r§7能力値を管理する"], "minecraft:experience_bottle");
    }
    form.button(6, `§d§lプロファイル: スロット ${activeProfile}`, ["§r§7ビルド切り替え"], "minecraft:name_tag");
    form.button(13, "§d§l📊 詳細ステータス", ["§r§7攻撃力・防御力などを確認"], "minecraft:spyglass");
    form.button(15, `§6§lマーケット (${gold} G)`, ["§r§eプレイヤー間取引所", "§7出品・購入・受取"], "minecraft:gold_ingot");
    form.button(20, "§6§lクエストログ", ["§r§7進行中のクエスト"], "minecraft:writable_book");
    form.button(26, "§c§lデバッグ: リセット", ["§r§cプロファイルをリセット"], "minecraft:barrier");
    form.button(24, "§e§lデバッグ: +1000 G", ["§r資金を追加"], "minecraft:sunflower");
    form.button(25, "§e§lデバッグ: +XP", ["§r+10000XP"], "minecraft:emerald");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 4) pendingDraws > 0 ? openCardSelection(player) : openStatusMenu(player);
        if (res.selection === 2) openTalentViewer(player);
        if (res.selection === 6) openProfileMenu(player);
        if (res.selection === 13) openDetailStats(player);
        if (res.selection === 15) openMarketMenu(player);
        if (res.selection === 20) openQuestMenu(player);
        if (res.selection === 26) resetCurrentProfile(player);
        if (res.selection === 24) {
            const current = player.getDynamicProperty("deepcraft:gold") || 0;
            player.setDynamicProperty("deepcraft:gold", current + 1000);
            player.playSound("random.orb");
            openMenuHub(player);
        }
        if (res.selection === 25) { addXP(player, 10000); openMenuHub(player); }
    });
}

function openDetailStats(player) {
    const stats = calculateEntityStats(player);
    const form = new ChestFormData("small");
    form.title("§lキャラクター詳細");
    
    // 内訳を説明文として結合する
    const atkDesc = ["§7物理攻撃力 (Total ATK)", "§8----------------", ...stats.details.atk];
    const defDesc = ["§7ダメージ軽減量 (Total DEF)", "§8----------------", ...stats.details.def];
    const critCDesc = ["§7クリティカル発生率", "§8----------------", ...stats.details.critChance];
    const critMDesc = ["§7クリティカル時のダメージ倍率", "§8----------------", ...stats.details.critMult];
    const etherDesc = [`§7自然回復: ${stats.etherRegen.toFixed(1)}/秒`, "§8----------------", ...stats.details.ether, ...stats.details.regen];
    const speedDesc = ["§7移動速度", "§8----------------", ...stats.details.speed];
    const evaDesc = ["§7ダメージ完全無効化率", "§8----------------", ...stats.details.evasion];

    form.button(10, `§c§l攻撃力: ${stats.atk}`, atkDesc, "minecraft:iron_sword");
    form.button(11, `§b§l防御力: ${stats.def}`, defDesc, "minecraft:shield");
    form.button(12, `§e§l会心率: ${(stats.critChance * 100).toFixed(1)}%`, critCDesc, "minecraft:gold_nugget");
    form.button(13, `§6§l会心倍率: ${(stats.critMult * 100).toFixed(0)}%`, critMDesc, "minecraft:blaze_powder");
    form.button(14, `§3§lエーテル: ${stats.maxEther}`, etherDesc, "minecraft:phantom_membrane");
    form.button(15, `§f§l速度: ${(stats.speed * 100).toFixed(0)}%`, speedDesc, "minecraft:feather");
    form.button(16, `§a§l回避率: ${(stats.evasion * 100).toFixed(1)}%`, evaDesc, "minecraft:sugar");
    
    form.button(26, "§c§l戻る", ["§rメニューへ戻る"], "minecraft:barrier");
    form.show(player).then(res => {
        if (!res.canceled && res.selection === 26) openMenuHub(player);
    });
}

function openProfileMenu(player) {
    const form = new ChestFormData("small");
    form.title("§lプロファイル管理");
    const activeSlot = player.getDynamicProperty("deepcraft:active_profile") || 1;
    for (let i = 1; i <= CONFIG.MAX_PROFILES; i++) {
        const isCurrent = (i === activeSlot);
        const slotJson = player.getDynamicProperty(`deepcraft:profile_${i}`);
        let desc = "§7空 / 初期状態";
        let level = 1;
        if (slotJson) { try { const data = JSON.parse(slotJson); level = data.level || 1; desc = `§7レベル: ${level}\n§7タレント数: ${data.talents.length}`; } catch(e) {} }
        const uiPos = 9 + (i * 2);
        let icon = isCurrent ? "minecraft:ender_chest" : "minecraft:chest";
        let name = isCurrent ? `§a§lスロット ${i} (使用中)` : `§lスロット ${i}`;
        form.button(uiPos, name, [desc, isCurrent ? "§a[現在のデータ]" : "§e[クリックでロード]"], icon, level);
    }
    form.button(26, "§c§l戻る", ["§rメニューへ戻る"], "minecraft:barrier");
    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 26) { openMenuHub(player); return; }
        let targetSlot = 0;
        if (res.selection === 11) targetSlot = 1;
        if (res.selection === 13) targetSlot = 2;
        if (res.selection === 15) targetSlot = 3;
        if (targetSlot > 0 && targetSlot !== activeSlot) {
            saveProfile(player, activeSlot);
            loadProfile(player, targetSlot);
            player.playSound("random.orb");
            player.sendMessage(`§aプロファイル スロット${targetSlot} をロードしました。`);
            openMenuHub(player);
        } else if (targetSlot === activeSlot) { player.sendMessage("§c既に使用中です。"); openProfileMenu(player); }
    });
}

function openStatusMenu(player) {
    const form = new ChestFormData("large");
    const level = player.getDynamicProperty("deepcraft:level");
    const invested = player.getDynamicProperty("deepcraft:invested_points");
    const remaining = CONFIG.STAT_POINTS_PER_LEVEL - invested;
    const currentXP = player.getDynamicProperty("deepcraft:xp");
    const cost = getXpCostForLevel(level);
    let titleText = `§lステータス | LvUpまで: ${remaining}pt`;
    if (level >= 20) {
        titleText = `§lステータス | ボーナス: ${remaining}pt (最大Lv)`;
        if (remaining <= 0) titleText = `§lステータス | §a§l完全強化済み (MAX)`;
    }
    form.title(`${titleText} | XP: ${currentXP}`);
    const layout = [
        { key: "strength", slot: 1 }, { key: "fortitude", slot: 3 }, { key: "agility", slot: 5 }, { key: "defense", slot: 7 },
        { key: "intelligence", slot: 11 }, { key: "willpower", slot: 13 }, { key: "charisma", slot: 15 },
        { key: "flame", slot: 28 }, { key: "frost", slot: 30 }, { key: "gale", slot: 32 }, { key: "thunder", slot: 34 },
        { key: "heavy", slot: 47 }, { key: "medium", slot: 49 }, { key: "light", slot: 51 }
    ];
    const slotToKeyMap = {};
    layout.forEach(item => {
        const key = item.key;
        const slot = item.slot;
        const val = player.getDynamicProperty(`deepcraft:${key}`) || 0;
        const name = CONFIG.STATS[key];
        let icon = "minecraft:book";
        if (key === "strength") icon = "minecraft:netherite_sword";
        if (key === "fortitude") icon = "minecraft:golden_apple";
        if (key === "agility") icon = "minecraft:sugar";
        if (key === "defense") icon = "minecraft:shield";
        if (key === "intelligence") icon = "minecraft:enchanted_book";
        if (key === "willpower") icon = "minecraft:beacon";
        if (key === "charisma") icon = "minecraft:diamond";
        if (key === "flame") icon = "minecraft:fire_charge";
        if (key === "frost") icon = "minecraft:snowball";
        if (key === "gale") icon = "minecraft:elytra";
        if (key === "thunder") icon = "minecraft:lightning_rod";
        if (key === "heavy") icon = "minecraft:anvil";
        if (key === "medium") icon = "minecraft:iron_chestplate";
        if (key === "light") icon = "minecraft:bow";
        
        let lore = [`§r§7Lv: §f${val}`, `§r§e必要: ${cost} XP`, `§r§8(クリックで強化)`];
        if (key === "intelligence") lore.push(`§b最大エーテル: +${Math.floor(val * CONFIG.ETHER_PER_INT)}`);
        if (key === "willpower") lore.push(`§bエーテル回復速度UP`);
        if (val >= 100) lore = [`§r§a§l最大レベル (100)`];

        form.button(slot, `§l${name}`, lore, icon, val);
        slotToKeyMap[slot] = key;
    });
    form.button(53, "§c§l戻る", ["§rメニューへ戻る"], "minecraft:barrier");
    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 53) { openMenuHub(player); return; }
        const selectedKey = slotToKeyMap[res.selection];
        if (selectedKey) upgradeStat(player, selectedKey);
    });
}

function openTalentViewer(player) {
    const form = new ChestFormData("large");
    form.title("§l習得済みタレント");
    let slot = 0;
    const tags = player.getTags();
    CARD_POOL.forEach(card => {
        if (tags.includes(`talent:${card.id}`)) {
            form.button(slot, card.name, [card.description, `§oレア度: ${card.rarity}`], "minecraft:enchanted_book");
            slot++;
        }
    });
    if (slot === 0) form.button(22, "§7タレントなし", ["§rまだタレントを持っていません。"], "minecraft:barrier");
    form.button(53, "§c§l戻る", ["§rメニューへ戻る"], "minecraft:barrier");
    form.show(player).then(res => { if (!res.canceled && res.selection === 53) openMenuHub(player); });
}

function openQuestMenu(player) {
    const form = new ChestFormData("large");
    form.title("§lクエストログ");
    const questData = JSON.parse(player.getDynamicProperty("deepcraft:quest_data") || "{}");
    let slot = 0;
    const questIds = [];
    const sortedKeys = Object.keys(questData).sort((a, b) => {
        const order = { "completed": 0, "active": 1, "claimed": 2 };
        return order[questData[a].status] - order[questData[b].status];
    });
    sortedKeys.forEach(qId => {
        const userQuest = questData[qId];
        const def = QUEST_POOL[qId];
        if (!def) return;
        let icon = "minecraft:book";
        let statusText = "";
        let clickText = "";
        let isGlint = false;
        if (userQuest.status === "active") { icon = "minecraft:book"; statusText = `§7進行度: §f${userQuest.progress} / ${def.amount}`; clickText = "§8(進行中)"; }
        else if (userQuest.status === "completed") { icon = "minecraft:emerald"; statusText = "§a§l完了！"; clickText = "§e[報酬を受け取る]"; isGlint = true; }
        else if (userQuest.status === "claimed") { icon = "minecraft:paper"; statusText = "§8(報酬受取済み)"; clickText = "§8終了"; }
        form.button(slot, def.name, [def.description, statusText, clickText], icon, 1, 0, isGlint);
        questIds[slot] = qId;
        slot++;
    });
    if (slot === 0) form.button(22, "§7進行中のクエストなし", ["§r世界を探索してクエストを探そう！"], "minecraft:barrier");
    form.button(53, "§c§l戻る", ["§rメニューへ戻る"], "minecraft:barrier");
    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 53) { openMenuHub(player); return; }
        const qId = questIds[res.selection];
        if (qId) {
            const userQuest = questData[qId];
            if (userQuest && userQuest.status === "completed") { claimQuestReward(player, qId); }
            else { openQuestMenu(player); }
        }
    });
}

function upgradeStat(player, statKey) {
    const invested = player.getDynamicProperty("deepcraft:invested_points") || 0;
    const level = player.getDynamicProperty("deepcraft:level") || 1;
    
    // 1. 限界チェック (Lv20以上かつポイントも振り切っていたらブロック)
    if (level >= 20 && invested >= CONFIG.STAT_POINTS_PER_LEVEL) {
        player.playSound("note.bass");
        player.sendMessage("§a§lこれ以上の強化は不可能です！(限界到達)");
        openStatusMenu(player);
        return;
    }

    const currentXP = player.getDynamicProperty("deepcraft:xp");
    const cost = getXpCostForLevel(level);
    const currentVal = player.getDynamicProperty(`deepcraft:${statKey}`) || 0;
    
    if (currentVal >= 100) {
        player.playSound("note.bass");
        player.sendMessage("§c既に最大レベルです！");
        openStatusMenu(player);
        return;
    }

    if (currentXP < cost) { 
        player.sendMessage(`§cXPが足りません！ 必要: ${cost}, 所持: ${currentXP}`); 
        openStatusMenu(player); 
        return; 
    }

    // 2. 計算と保存
    const nextInvested = invested + 1;
    player.setDynamicProperty("deepcraft:xp", currentXP - cost);
    player.setDynamicProperty(`deepcraft:${statKey}`, currentVal + 1);
    player.playSound("random.levelup");
    player.sendMessage(`§a強化完了: ${CONFIG.STATS[statKey]} -> ${currentVal + 1}`);
    try { applyStatsToEntity(player); } catch(e) {}

    // 3. 分岐処理
    if (nextInvested >= CONFIG.STAT_POINTS_PER_LEVEL) {
        if (level < 20) {
            // 通常レベルアップ: ポイントを0にリセットして次へ
            player.setDynamicProperty("deepcraft:invested_points", 0);
            player.setDynamicProperty("deepcraft:level", level + 1);
            
            let pending = player.getDynamicProperty("deepcraft:pending_card_draws") || 0;
            player.setDynamicProperty("deepcraft:pending_card_draws", pending + 1);
            
            player.sendMessage(`§6§lレベルアップ！ §r(Lv.${level + 1})`);
            player.playSound("ui.toast.challenge_complete");
            system.runTimeout(() => openMenuHub(player), 20);
        } else {
            // ★修正: カンスト到達時はポイントをリセットせず「15」のまま保存する
            // これにより、次回のクリック時に冒頭の「限界チェック」で弾かれるようになる
            player.setDynamicProperty("deepcraft:invested_points", nextInvested);
            
            player.sendMessage("§6§l最大レベルボーナス完了！");
            player.playSound("ui.toast.challenge_complete");
            system.runTimeout(() => openMenuHub(player), 20);
        }
    } else {
        // まだ途中: 加算したポイントを保存
        player.setDynamicProperty("deepcraft:invested_points", nextInvested);
        openStatusMenu(player);
    }
}

function openCardSelection(player) {
    const form = new ChestFormData("small");
    form.title("§lタレント選択");

    // ★修正: 保存された抽選データがあるか確認
    let selectionIds = [];
    const tempJson = player.getDynamicProperty("deepcraft:temp_talent_roll");
    
    if (tempJson) {
        // データがあればそれを使う（リロール防止）
        try { selectionIds = JSON.parse(tempJson); } catch(e){}
    } 
    
    // データがない（または壊れている）場合は新規抽選
    if (!selectionIds || selectionIds.length === 0) {
        const availableCards = CARD_POOL.filter(card => {
            const hasTalent = player.hasTag(`talent:${card.id}`);
            const conditionsMet = card.condition(player);
            return conditionsMet && !hasTalent;
        });
        const shuffled = availableCards.sort(() => 0.5 - Math.random());
        const selectedCards = shuffled.slice(0, 3);
        
        if (selectedCards.length === 0) { 
            const filler = CARD_POOL.find(c => c.id === "basic_training"); 
            if (filler) selectedCards.push(filler); 
        }
        
        // IDリストにして保存
        selectionIds = selectedCards.map(c => c.id);
        player.setDynamicProperty("deepcraft:temp_talent_roll", JSON.stringify(selectionIds));
    }

    // IDからカード情報を復元して表示
    const positions = [11, 13, 15];
    selectionIds.forEach((cardId, index) => {
        const card = CARD_POOL.find(c => c.id === cardId);
        if (!card) return;

        let icon = "minecraft:enchanted_book";
        if (card.rarity === "legendary") icon = "minecraft:nether_star";
        form.button(positions[index], card.name, [card.description, `§o${card.rarity.toUpperCase()}`, `§8条件: ${card.conditionText}`], icon, 1, 0, true);
    });
    
    form.show(player).then((response) => {
        if (response.canceled) { player.sendMessage("§cタレントを選択してください。"); openMenuHub(player); return; }
        const idx = positions.indexOf(response.selection);
        // 選ばれたIDを特定して適用へ
        if (idx !== -1 && selectionIds[idx]) { 
            const card = CARD_POOL.find(c => c.id === selectionIds[idx]);
            if (card) applyCardEffect(player, card); 
        }
    });
}

function applyCardEffect(player, card) {
    let pending = player.getDynamicProperty("deepcraft:pending_card_draws") || 0;
    if (pending > 0) player.setDynamicProperty("deepcraft:pending_card_draws", pending - 1);
    
    // ★追加: 決定したので一時保存データを消去
    player.setDynamicProperty("deepcraft:temp_talent_roll", undefined);

    player.sendMessage(`§aタレント獲得: ${card.name}`);
    
    // (以下は変更なし)
    if (card.id !== "basic_training") player.addTag(`talent:${card.id}`);
    if (card.type === "xp") {
        addXP(player, card.value);
        const currentSlot = player.getDynamicProperty("deepcraft:active_profile") || 1;
        saveProfile(player, currentSlot);
        system.runTimeout(() => openMenuHub(player), 10);
        return;
    }
    if (card.type === "stat") {
        if (Array.isArray(card.stat)) { card.stat.forEach(s => { const val = player.getDynamicProperty(`deepcraft:${s}`) || 0; player.setDynamicProperty(`deepcraft:${s}`, val + card.value); }); }
        else if (card.stat === "all") { for (const key in CONFIG.STATS) { const val = player.getDynamicProperty(`deepcraft:${key}`) || 0; player.setDynamicProperty(`deepcraft:${key}`, val + card.value); } }
        else { const val = player.getDynamicProperty(`deepcraft:${card.stat}`) || 0; player.setDynamicProperty(`deepcraft:${card.stat}`, val + card.value); }
        applyStatsToEntity(player);
    }
    const currentSlot = player.getDynamicProperty("deepcraft:active_profile") || 1;
    saveProfile(player, currentSlot);
    system.runTimeout(() => openMenuHub(player), 10);
}

function resetCurrentProfile(player) {
    const currentSlot = player.getDynamicProperty("deepcraft:active_profile") || 1;
    player.setDynamicProperty(`deepcraft:profile_${currentSlot}`, undefined);
    player.setDynamicProperty("deepcraft:quest_data", undefined);
    player.setDynamicProperty("deepcraft:ether", CONFIG.ETHER_BASE);
    loadProfile(player, currentSlot);
    player.playSound("random.break");
    player.sendMessage(`§c[デバッグ] プロファイル スロット${currentSlot} をリセットしました。`);
}

// --- Combat Logging Prevention (Instant Drop) ---

// --- Combat Logging Prevention (Fix: Read-Only Safe) ---

// --- Combat Logging Prevention (After Leave) ---

world.afterEvents.playerLeave.subscribe((ev) => {
    // 退出したプレイヤーのID
    const playerId = ev.playerId;

    // バックアップがあるか確認
    const backup = COMBAT_LOG_CACHE.get(playerId);
    
    if (backup) {
        // バックアップがある＝戦闘中に落ちた
        try {
            const dim = world.getDimension(backup.dimensionId);
            const spawnLoc = { x: backup.location.x, y: backup.location.y + 1.0, z: backup.location.z };
            
            // Soulを生成
            const soul = dim.spawnEntity("minecraft:chest_minecart", spawnLoc);
            soul.nameTag = `§c${backup.name}の逃亡跡 (Soul)`;
            // 本来の所有者IDを記録
            soul.setDynamicProperty("deepcraft:owner_id", playerId);

            // アイテムを格納
            const soulContainer = soul.getComponent("inventory").container;
            backup.items.forEach(item => {
                if (item) soulContainer.addItem(item);
            });

            // 次回ログイン時の処刑フラグを「ワールド」に保存
            // (プレイヤーエンティティはもういないため、ワールドに記録する)
            world.setDynamicProperty(`combat_log:${playerId}`, true);
            
            // ログ
            world.sendMessage(`§c§l${backup.name} が戦闘から逃亡しました！ アイテムがその場にドロップしました。`);

            // 処理が終わったらキャッシュを消す
            COMBAT_LOG_CACHE.delete(playerId);

        } catch(e) {
            console.warn(`Combat Log Drop Error: ${e}`);
        }
    }
});

