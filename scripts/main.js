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

// --- Initialization ---

world.afterEvents.playerSpawn.subscribe((ev) => {
    try {
        const player = ev.player;
        
        // 初回初期化
        if (!player.getDynamicProperty("deepcraft:active_profile")) {
            initializePlayer(player);
        }

        // ★修正: 仮想HPを必ず最大値にリセット (ゾンビ化防止)
        const maxHP = player.getDynamicProperty("deepcraft:max_hp") || 100;
        player.setDynamicProperty("deepcraft:hp", maxHP);

        // ★修正: 無敵時間管理用の数値をリセット (計算バグ防止)
        player.setDynamicProperty("deepcraft:last_hurt_tick", system.currentTick);

        // バニラHPを全回復 (器の修復)
        const hp = player.getComponent("minecraft:health");
        if (hp) hp.resetToMax();
        
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

// --- System Loop (Main Cycle) ---

system.runInterval(() => {
    // 1. Player Loop (安全化)
    // ※ try-catchをforEachの中に移動し、一人エラーが出ても全員止まらないようにする
    world.getAllPlayers().forEach(player => {
        try {
            if (!player.isValid()) return;

            const level = player.getDynamicProperty("deepcraft:level") || 1;
            const xp = player.getDynamicProperty("deepcraft:xp") || 0;
            const reqXp = getXpCostForLevel(level);
            
            const intelligence = player.getDynamicProperty("deepcraft:intelligence") || 0;
            const willpower = player.getDynamicProperty("deepcraft:willpower") || 0;

            // Ether Logic
            const maxEther = Math.floor(CONFIG.ETHER_BASE + (intelligence * CONFIG.ETHER_PER_INT));
            let currentEther = player.getDynamicProperty("deepcraft:ether") || 0;
            const regenRate = CONFIG.ETHER_REGEN_BASE + (willpower * CONFIG.ETHER_REGEN_PER_WILL);
            const tickRegen = regenRate / 10; 
            
            if (currentEther < maxEther) {
                currentEther = Math.min(maxEther, currentEther + tickRegen);
                player.setDynamicProperty("deepcraft:ether", currentEther);
            }

            // HUD Display
            const currentHP = Math.floor(player.getDynamicProperty("deepcraft:hp") || 100);
            const maxHP = Math.floor(player.getDynamicProperty("deepcraft:max_hp") || 100);
            const etherPercent = Math.max(0, Math.min(1, currentEther / maxEther));
            const etherBarLen = 10; 
            const etherFill = Math.ceil(etherPercent * etherBarLen);
            const etherBarDisplay = "§b" + "■".repeat(etherFill) + "§8" + "■".repeat(etherBarLen - etherFill);
            const gold = player.getDynamicProperty("deepcraft:gold") || 0;

            player.onScreenDisplay.setActionBar(
                `§cHP: ${currentHP}/${maxHP}   ` +
                `§3Ether: ${etherBarDisplay} ${Math.floor(currentEther)}/${maxEther}\n` +
                `§eLv.${level}   §fXP:${xp}/${reqXp}   §6${gold} G`
            );
            
            // バニラHP回復（念のため）
            const vanillaHp = player.getComponent("minecraft:health");
            if (vanillaHp && vanillaHp.currentValue < 100) vanillaHp.resetToMax();

            applyEquipmentPenalties(player);
            applyNumericalPassives(player);
            applyStatsToEntity(player);

        } catch (e) {
            // 個別のプレイヤーエラーはここで吸収し、他プレイヤーに影響させない
            // console.warn(`Player Loop Error (${player.name}): ${e}`);
        }
    });

    // 2. Boss Loop
    try {
        world.getDimension("overworld").getEntities({ tags: ["deepcraft:boss"] }).forEach(boss => {
            updateMobNameTag(boss);
            processBossSkillAI(boss);
        });
    } catch (e) { console.warn("Boss Loop Error: " + e); }

}, 2); // 0.1秒ごとに実行

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
        atk: 0,
        def: 0,
        critChance: CONFIG.COMBAT.BASE_CRIT_CHANCE,
        critMult: CONFIG.COMBAT.BASE_CRIT_MULT,
        speed: 1.0,
        maxEther: 0,
        etherRegen: 0,
        maxHP: 20
    };

    if (entity.typeId === "minecraft:player") {
        const str = entity.getDynamicProperty("deepcraft:strength") || 0;
        const fort = entity.getDynamicProperty("deepcraft:fortitude") || 0;
        const agi = entity.getDynamicProperty("deepcraft:agility") || 0;
        const int = entity.getDynamicProperty("deepcraft:intelligence") || 0;
        const will = entity.getDynamicProperty("deepcraft:willpower") || 0;
        const defStat = entity.getDynamicProperty("deepcraft:defense") || 0;
        const level = entity.getDynamicProperty("deepcraft:level") || 1;

        const equip = entity.getComponent("equippable");
        const mainHand = equip.getEquipment(EquipmentSlot.Mainhand);
        const equipStats = { atk: 0, def: 0 };
        const weaponDef = getEquipmentStats(mainHand);
        equipStats.atk += weaponDef.atk;
        [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet].forEach(slot => {
            equipStats.def += getEquipmentStats(equip.getEquipment(slot)).def;
        });

        let atk = level + (str * 0.5) + equipStats.atk;
        if (entity.hasTag("talent:brute_force")) atk += 2;
        if (entity.hasTag("talent:glass_cannon")) atk *= 1.5;
        if (entity.hasTag("talent:sharp_blade")) atk *= 1.1;
        
        const hpProp = entity.getDynamicProperty("deepcraft:hp") || 100;
        const hpMaxProp = entity.getDynamicProperty("deepcraft:max_hp") || 100;
        if (entity.hasTag("talent:berserker") && (hpProp / hpMaxProp < 0.3)) atk *= 1.5;
        if (entity.hasTag("talent:assassin") && entity.isSneaking) atk *= 2.0;
        
        stats.atk = Math.floor(atk);

        stats.critChance += (agi * 0.001) + (int * 0.0005);
        if (entity.hasTag("talent:eagle_eye")) stats.critChance += 0.1;
        stats.critMult += (str * 0.005);

        let def = defStat + (fort * CONFIG.COMBAT.DEFENSE_CONSTANT) + equipStats.def;
        if (entity.hasTag("talent:tough_skin")) def += 2;
        if (entity.hasTag("talent:iron_wall")) def += 5;
        if (entity.hasTag("talent:last_stand") && (hpProp / hpMaxProp < 0.3)) def *= 1.5;
        stats.def = Math.floor(def);

        stats.maxEther = Math.floor(CONFIG.ETHER_BASE + (int * CONFIG.ETHER_PER_INT));
        stats.etherRegen = CONFIG.ETHER_REGEN_BASE + (will * CONFIG.ETHER_REGEN_PER_WILL);

        let hp = 18 + (fort * 2);
        if (entity.hasTag("talent:vitality_1")) hp += 4;
        if (entity.hasTag("talent:vitality_2")) hp += 10;
        if (entity.hasTag("talent:glass_cannon")) hp = Math.floor(hp * 0.5);
        stats.maxHP = Math.floor(hp);

        let speedIndex = 10 + Math.floor(agi * 0.2);
        if (entity.hasTag("talent:swift_1")) speedIndex += 5; 
        if (entity.hasTag("talent:godspeed")) speedIndex += 15;
        if (entity.hasTag("debuff:heavy_armor")) speedIndex = Math.max(5, speedIndex - 10);
        stats.speed = speedIndex * 0.01;
    } 
    else {
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
        stats.atk = 5;
        stats.def = 0;
    }
    return stats;
}

// --- Events ---

world.afterEvents.itemUse.subscribe((ev) => {
    const player = ev.source;
    const item = ev.itemStack;
    if (item.typeId === "minecraft:compass") { openMenuHub(player); return; }

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

system.afterEvents.scriptEventReceive.subscribe((ev) => {
    if (!ev.sourceEntity) return;
    if (ev.id === "deepcraft:addxp") { addXP(ev.sourceEntity, parseInt(ev.message) || 1000); }
    if (ev.id === "deepcraft:quest") { acceptQuest(ev.sourceEntity, ev.message); }
    if (ev.id === "deepcraft:give") { giveCustomItem(ev.sourceEntity, ev.message); }
    if (ev.id === "deepcraft:summon") { summonBoss(ev.sourceEntity, ev.message); }
    if (ev.id === "deepcraft:sell") { processCommandSell(ev.sourceEntity, ev.message); }
    if (ev.id === "deepcraft:max") {
        const player = ev.sourceEntity;
        for (const key in CONFIG.STATS) player.setDynamicProperty(`deepcraft:${key}`, 100);
        player.setDynamicProperty("deepcraft:level", 100);
        player.setDynamicProperty("deepcraft:ether", 1000);
        applyStatsToEntity(player);
        player.sendMessage("§e§l[デバッグ] 全ステータスを最大化しました！");
    }
});

// ==========================================
//  ⚔️ Modified Combat Logic
//  (No Reset, No Cooldown)
// ==========================================

world.afterEvents.entityHurt.subscribe((ev) => {
    const victim = ev.hurtEntity;
    const attacker = ev.damageSource.damagingEntity;
    const damageAmount = ev.damage;

    // ループ防止: システムによる強制キル（9999ダメージ）は無視する
    if (damageAmount >= 9999) return;

    // --- [削除] 無敵時間チェック ---
    // --- [削除] バニラHPの全回復 ---

    // 1. ステータス計算
    const victimStats = calculateEntityStats(victim);
    
    // 2. ダメージ計算
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
            // 回避時もダメージは通さない（仮想HPを減らさない）
            return; 
        }
    }

    finalDamage = Math.max(CONFIG.COMBAT.MIN_DAMAGE, finalDamage - victimStats.def);
    finalDamage = Math.floor(finalDamage);

    // 反射
    if (attacker) {
        if (victim.hasTag("talent:thorns_aura")) {
             const attCur = attacker.getDynamicProperty("deepcraft:hp");
             if (attCur) attacker.setDynamicProperty("deepcraft:hp", Math.max(0, attCur - 2));
        }
        if (victim.hasTag("talent:thorns_master")) {
             const attCur = attacker.getDynamicProperty("deepcraft:hp");
             if (attCur) attacker.setDynamicProperty("deepcraft:hp", Math.max(0, attCur - Math.floor(finalDamage * 0.3)));
        }
    }

    // 3. 仮想HPへのダメージ適用
    const currentHP = victim.getDynamicProperty("deepcraft:hp"); 
    const actualCurrentHP = (currentHP !== undefined) ? currentHP : victimStats.maxHP;
    
    const newHP = actualCurrentHP - finalDamage;
    victim.setDynamicProperty("deepcraft:hp", newHP);

    if (victim.typeId !== "minecraft:player") {
        updateMobNameTag(victim);
    }

    // 死亡判定
    if (newHP <= 0) {
        victim.applyDamage(9999);
        return;
    }

    // クリティカル演出
    if (isCritical) {
        victim.dimension.playSound("random.anvil_land", victim.location, { pitch: 2.0 });
        victim.dimension.spawnParticle("minecraft:critical_hit_emitter", { x: victim.location.x, y: victim.location.y + 1, z: victim.location.z });
        if (attacker && attacker.typeId === "minecraft:player") {
            attacker.sendMessage(`§c§lクリティカル！ §r§6${finalDamage} ダメージ`);
        }
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

        // 攻撃者への報酬処理
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

        // プレイヤー死亡時の処理 (Soul生成)
        if (victim.typeId === "minecraft:player") {
            const player = victim;
            
            // 仮想HPリセット
            player.setDynamicProperty("deepcraft:hp", player.getDynamicProperty("deepcraft:max_hp"));
            
            // XPロスト
            const lostXP = player.getDynamicProperty("deepcraft:xp") || 0;
            player.setDynamicProperty("deepcraft:xp", 0);
            if (lostXP > 0) player.sendMessage(`§c死亡により ${lostXP} XPを失いました...`);

            // アイテム保存ロジック
            const inventory = player.getComponent("inventory").container;
            const deathDimension = player.dimension;
            const deathLocation = player.location; // 死亡座標を確保

            let droppedItems = [];
            for (let i = 0; i < inventory.size; i++) {
                const item = inventory.getItem(i);
                if (item) {
                    if (Math.random() < CONFIG.DEATH_ITEM_DROP_RATE) {
                        droppedItems.push(item.clone());
                        inventory.setItem(i, null);
                    }
                }
            }

            // Soul生成を1tick遅らせることで、死亡直後の不安定な状態や同時死亡の競合を回避
            if (droppedItems.length > 0) {
                system.runTimeout(() => {
                    try {
                        const spawnLoc = { x: deathLocation.x, y: deathLocation.y + 1.0, z: deathLocation.z };
                        const soul = deathDimension.spawnEntity("minecraft:chest_minecart", spawnLoc);
                        soul.nameTag = "§b魂 (Soul)";
                        
                        // Soulの所有権を設定（マルチプレイ用：他人が開けられないようにする拡張用）
                        soul.setDynamicProperty("owner_id", player.id);
                        soul.setDynamicProperty("is_soul", true);

                        const soulContainer = soul.getComponent("inventory").container;
                        droppedItems.forEach(item => soulContainer.addItem(item));
                        
                        // プレイヤーに通知（リスポーン後に届く可能性が高い）
                        const returningPlayer = world.getAllPlayers().find(p => p.id === player.id);
                        if (returningPlayer) {
                            returningPlayer.sendMessage(`§bアイテムを魂として座標 [${Math.floor(spawnLoc.x)}, ${Math.floor(spawnLoc.y)}, ${Math.floor(spawnLoc.z)}] に残しました。`);
                        }
                    } catch (e) {
                        console.warn("Soul Spawn Error: " + e);
                    }
                }, 1); // 1tick遅延
            }
        }
    } catch(e) { console.warn("Entity Die Error: " + e); }
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
    form.button(25, "§e§lデバッグ: +XP", ["§r+1000 XP"], "minecraft:emerald");

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
        if (res.selection === 25) { addXP(player, 1000); openMenuHub(player); }
    });
}

function openDetailStats(player) {
    const stats = calculateEntityStats(player);
    const form = new ChestFormData("small");
    form.title("§lキャラクター詳細");
    form.button(10, `§c§l攻撃力: ${stats.atk}`, ["§7物理攻撃力"], "minecraft:iron_sword");
    form.button(11, `§b§l防御力: ${stats.def}`, ["§7ダメージ軽減量"], "minecraft:shield");
    form.button(12, `§e§l会心率: ${(stats.critChance * 100).toFixed(1)}%`, ["§7クリティカル発生率"], "minecraft:gold_nugget");
    form.button(13, `§6§l会心倍率: ${(stats.critMult * 100).toFixed(0)}%`, ["§7クリティカル時のダメージ倍率"], "minecraft:blaze_powder");
    form.button(14, `§3§lエーテル: ${stats.maxEther}`, [`§7自然回復: ${stats.etherRegen}/秒`], "minecraft:phantom_membrane");
    form.button(15, `§f§l速度: ${(stats.speed * 100).toFixed(0)}%`, ["§7移動速度"], "minecraft:feather");
    form.button(26, "§c§l戻る", ["§rメニューへ戻る"], "minecraft:barrier");
    form.show(player).then(res => { if (!res.canceled && res.selection === 26) openMenuHub(player); });
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
    
    // --- 1. 限界到達チェック (救済措置) ---
    // レベル20未満であれば、ポイントが15を超えていても通過させる（バグ修正のため）
    // レベル20以上かつポイントも満タンの場合のみブロックする
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
        player.sendMessage(`§c${CONFIG.STATS[statKey]} は既に最大レベル(100)です！`);
        openStatusMenu(player);
        return;
    }

    if (currentXP < cost) { 
        player.sendMessage(`§cXPが足りません！ 必要: ${cost}, 所持: ${currentXP}`); 
        openStatusMenu(player); 
        return; 
    }

    // --- 2. 値の計算 (保存はまだしない) ---
    const nextInvested = invested + 1;
    
    // 共通: XP消費とステータス加算は先に保存しても問題ない
    player.setDynamicProperty("deepcraft:xp", currentXP - cost);
    player.setDynamicProperty(`deepcraft:${statKey}`, currentVal + 1);
    
    player.playSound("random.levelup");
    player.sendMessage(`§a強化完了: ${CONFIG.STATS[statKey]} -> ${currentVal + 1}`);
    applyStatsToEntity(player);

    // --- 3. 分岐とアトミック保存 ---
    
    // 規定値(15)に達したか？ (バグで16以上になっていてもここで回収する)
    if (nextInvested >= CONFIG.STAT_POINTS_PER_LEVEL) {
        // 【ルートB: レベルアップ】
        // 投資ポイントを「必ず 0」にして保存 (15や16を保存しない)
        player.setDynamicProperty("deepcraft:invested_points", 0);

        if (level < 20) {
            // レベルを加算
            player.setDynamicProperty("deepcraft:level", level + 1);
            
            // タレント抽選権を付与
            let pending = player.getDynamicProperty("deepcraft:pending_card_draws") || 0;
            player.setDynamicProperty("deepcraft:pending_card_draws", pending + 1);
            
            player.sendMessage(`§6§lレベルアップ！ §r(Lv.${level + 1})`);
            player.playSound("ui.toast.challenge_complete");
            
            // メニューを閉じてハブへ (連打防止)
            system.runTimeout(() => openMenuHub(player), 20);
        } else {
            // Lv20ボーナス完了
            player.sendMessage("§6§l最大レベルボーナス完了！");
            player.playSound("ui.toast.challenge_complete");
            system.runTimeout(() => openMenuHub(player), 20);
        }
    } else {
        // 【ルートA: 通常強化】
        // 計算した次の値を保存
        player.setDynamicProperty("deepcraft:invested_points", nextInvested);
        
        // 続けて強化できるようにメニューを再表示
        openStatusMenu(player);
    }
}

function openCardSelection(player) {
    const form = new ChestFormData("small");
    form.title("§lタレント選択");
    const availableCards = CARD_POOL.filter(card => {
        const hasTalent = player.hasTag(`talent:${card.id}`);
        const conditionsMet = card.condition(player);
        return conditionsMet && !hasTalent;
    });
    const shuffled = availableCards.sort(() => 0.5 - Math.random());
    const selection = shuffled.slice(0, 3);
    const positions = [11, 13, 15];
    if (selection.length === 0) { const filler = CARD_POOL.find(c => c.id === "basic_training"); if (filler) selection.push(filler); }
    selection.forEach((card, index) => {
        let icon = "minecraft:enchanted_book";
        if (card.rarity === "legendary") icon = "minecraft:nether_star";
        form.button(positions[index], card.name, [card.description, `§o${card.rarity.toUpperCase()}`, `§8条件: ${card.conditionText}`], icon, 1, 0, true);
    });
    form.show(player).then((response) => {
        if (response.canceled) { player.sendMessage("§cタレントを選択してください。"); openMenuHub(player); return; }
        const idx = positions.indexOf(response.selection);
        if (idx !== -1 && selection[idx]) { applyCardEffect(player, selection[idx]); }
    });
}

function applyCardEffect(player, card) {
    let pending = player.getDynamicProperty("deepcraft:pending_card_draws") || 0;
    if (pending > 0) player.setDynamicProperty("deepcraft:pending_card_draws", pending - 1);
    player.sendMessage(`§aタレント獲得: ${card.name}`);
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