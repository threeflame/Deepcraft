// BP/scripts/main.js
import { world, system, ItemStack, EquipmentSlot } from "@minecraft/server";
import { ChestFormData } from "./extensions/forms.js";

// Data Imports
import { CONFIG } from "./config.js";
import { CARD_POOL } from "./data/talents.js";
import { QUEST_POOL } from "./data/quests.js";
import { EQUIPMENT_POOL } from "./data/equipment.js";
import { SKILL_POOL } from "./data/skills.js";
import { MOB_POOL } from "./data/mobs.js";

// --- Initialization ---

world.afterEvents.playerSpawn.subscribe((ev) => {
    const player = ev.player;
    if (!player.getDynamicProperty("deepcraft:active_profile")) {
        initializePlayer(player);
    }
});

function initializePlayer(player) {
    player.setDynamicProperty("deepcraft:active_profile", 1);
    player.setDynamicProperty("deepcraft:ether", CONFIG.ETHER_BASE);
    loadProfile(player, 1);
    player.sendMessage("§aDeepCraft System Initialized.");
}

// --- System Loop (Main Cycle) ---

system.runInterval(() => {
    // 1. Player Loop
    world.getAllPlayers().forEach(player => {
        const level = player.getDynamicProperty("deepcraft:level") || 1;
        const xp = player.getDynamicProperty("deepcraft:xp") || 0;
        const reqXp = getXpCostForLevel(level);
        
        const intelligence = player.getDynamicProperty("deepcraft:intelligence") || 0;
        const willpower = player.getDynamicProperty("deepcraft:willpower") || 0;

        // Ether Logic
        const maxEther = Math.floor(CONFIG.ETHER_BASE + (intelligence * CONFIG.ETHER_PER_INT));
        let currentEther = player.getDynamicProperty("deepcraft:ether") || 0;

        // Regen (5tick = 0.25s interval)
        const regenRate = CONFIG.ETHER_REGEN_BASE + (willpower * CONFIG.ETHER_REGEN_PER_WILL);
        const tickRegen = regenRate / 4; 
        
        if (currentEther < maxEther) {
            currentEther = Math.min(maxEther, currentEther + tickRegen);
            player.setDynamicProperty("deepcraft:ether", currentEther);
        }

        // HUD Display
        const etherPercent = Math.max(0, Math.min(1, currentEther / maxEther));
        const etherBarLen = 10; 
        const etherFill = Math.ceil(etherPercent * etherBarLen);
        const etherBarDisplay = "§b" + "■".repeat(etherFill) + "§8" + "■".repeat(etherBarLen - etherFill);

        player.onScreenDisplay.setActionBar(
            `§eLv.${level} §f[XP: §a${xp}§f/§c${reqXp}§f]\n` +
            `§3Ether: ${etherBarDisplay} §b${Math.floor(currentEther)}§3/§b${maxEther}`
        );

        // Checks
        applyEquipmentPenalties(player);
        applyNumericalPassives(player);
        applyStatsToEntity(player);
    });

    // 2. Boss Loop
    world.getDimension("overworld").getEntities({ tags: ["deepcraft:boss"] }).forEach(boss => {
        updateBossNameTag(boss);
        processBossSkillAI(boss);
    });

}, 5);

function getXpCostForLevel(level) {
    return CONFIG.XP_BASE_COST + (level * CONFIG.XP_LEVEL_MULTIPLIER);
}

// --- Boss Logic ---

function updateBossNameTag(boss) {
    if (!boss.isValid()) return;
    const hp = boss.getComponent("minecraft:health");
    const bossId = boss.getDynamicProperty("deepcraft:boss_id");
    const bossDef = MOB_POOL[bossId];
    
    if (hp && bossDef) {
        const current = Math.ceil(hp.currentValue);
        const max = hp.effectiveMax;
        const percent = Math.max(0, current / max);
        
        const barLen = 10;
        const fill = Math.ceil(percent * barLen);
        const bar = "§a" + "|".repeat(fill) + "§c" + "|".repeat(barLen - fill);
        
        boss.nameTag = `${bossDef.name}\n${bar} §f${current}/${max}`;
    }
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
        boss.dimension.runCommand(`tellraw @a[r=30,x=${boss.location.x},y=${boss.location.y},z=${boss.location.z}] {"rawtext":[{"text":"§e[BOSS] ${skill.msg}"}]}`);
    }
    skill.action(boss);
}

// --- Player Skill (Right Click) ---

function executeSkill(player, skillId) {
    const skill = SKILL_POOL[skillId];
    if (!skill) return;

    // 1. Cooldown Check
    const cdTag = `cooldown:skill_${skillId}`;
    if (player.hasTag(cdTag)) {
        player.playSound("note.bass");
        player.sendMessage("§cSkill is on cooldown!");
        return;
    }

    // 2. Mana Cost Check
    const manaCost = skill.manaCost || 0;
    let currentEther = player.getDynamicProperty("deepcraft:ether") || 0;
    
    if (currentEther < manaCost) {
        player.playSound("note.bass");
        player.sendMessage(`§cNot enough Ether! (§b${Math.floor(currentEther)} §c/ §b${manaCost}§c)`);
        return;
    }

    // 3. Execute
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
                player.sendMessage(`§aSkill Ready: ${skill.name}`);
            }
        }, skill.cooldown * 20);
    }
}

// --- Core Logic: Stat Calculation ---
// 戦闘とメニュー表示の両方で使う共通計算ロジック
function calculateEntityStats(entity) {
    const stats = {
        atk: 0,
        def: 0,
        critChance: CONFIG.COMBAT.BASE_CRIT_CHANCE,
        critMult: CONFIG.COMBAT.BASE_CRIT_MULT,
        speed: 1.0, // 1.0 = 100%
        maxEther: 0,
        etherRegen: 0
    };

    // プレイヤーの場合の計算
    if (entity.typeId === "minecraft:player") {
        // 基礎ステータス取得
        const str = entity.getDynamicProperty("deepcraft:strength") || 0;
        const fort = entity.getDynamicProperty("deepcraft:fortitude") || 0;
        const agi = entity.getDynamicProperty("deepcraft:agility") || 0;
        const int = entity.getDynamicProperty("deepcraft:intelligence") || 0;
        const will = entity.getDynamicProperty("deepcraft:willpower") || 0;
        const defStat = entity.getDynamicProperty("deepcraft:defense") || 0;
        const level = entity.getDynamicProperty("deepcraft:level") || 1;

        // 装備ステータス取得
        const equip = entity.getComponent("equippable");
        const mainHand = equip.getEquipment(EquipmentSlot.Mainhand);
        const equipStats = { atk: 0, def: 0 };
        
        // 武器
        const weaponDef = getEquipmentStats(mainHand);
        equipStats.atk += weaponDef.atk;
        
        // 防具 (簡易計算)
        [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet].forEach(slot => {
            equipStats.def += getEquipmentStats(equip.getEquipment(slot)).def;
        });

        // 1. 攻撃力 (ATK)
        // Base: Lv + Str*0.5 + Weapon
        let atk = level + (str * 0.5) + equipStats.atk;
        
        // タレント補正
        if (entity.hasTag("talent:brute_force")) atk += 2;
        if (entity.hasTag("talent:glass_cannon")) atk *= 1.5;
        if (entity.hasTag("talent:sharp_blade")) atk *= 1.1;
        
        // 条件付き補正
        const hp = entity.getComponent("minecraft:health");
        if (entity.hasTag("talent:berserker") && hp && hp.currentValue < hp.effectiveMax * 0.3) {
            atk *= 1.5;
        }
        if (entity.hasTag("talent:assassin") && entity.isSneaking) {
            atk *= 2.0;
        }
        stats.atk = Math.floor(atk);

        // 2. クリティカル (Crit)
        // Chance: Base + Agi*0.1% + Int*0.05%
        stats.critChance += (agi * 0.001) + (int * 0.0005);
        if (entity.hasTag("talent:eagle_eye")) stats.critChance += 0.1;
        
        // Mult: Base + Str*0.5%
        stats.critMult += (str * 0.005);

        // 3. 防御力 (DEF)
        // Base: Def*1.0 + Fort*0.5 + Equip
        let def = defStat + (fort * CONFIG.COMBAT.DEFENSE_CONSTANT) + equipStats.def;
        
        if (entity.hasTag("talent:tough_skin")) def += 2;
        if (entity.hasTag("talent:iron_wall")) def += 5;
        if (entity.hasTag("talent:last_stand") && hp && hp.currentValue < hp.effectiveMax * 0.3) {
            def *= 1.5;
        }
        stats.def = Math.floor(def);

        // 4. エーテル (Ether)
        stats.maxEther = Math.floor(CONFIG.ETHER_BASE + (int * CONFIG.ETHER_PER_INT));
        stats.etherRegen = CONFIG.ETHER_REGEN_BASE + (will * CONFIG.ETHER_REGEN_PER_WILL);

        // 5. 移動速度 (Speed) - 表示用
        let speedIndex = 10 + Math.floor(agi * 0.2);
        if (entity.hasTag("talent:swift_1")) speedIndex += 5; 
        if (entity.hasTag("talent:godspeed")) speedIndex += 15;
        if (entity.hasTag("debuff:heavy_armor")) speedIndex = Math.max(5, speedIndex - 10);
        stats.speed = speedIndex * 0.01; // movement0.1 = 100%
    } 
    // Mobの場合 (簡易)
    else {
        stats.atk = 5; // 仮
        stats.def = 0;
    }

    return stats;
}

// --- Events (Combat & Menu) ---

world.afterEvents.itemUse.subscribe((ev) => {
    const player = ev.source;
    const item = ev.itemStack;

    if (item.typeId === "minecraft:compass") {
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

system.afterEvents.scriptEventReceive.subscribe((ev) => {
    if (!ev.sourceEntity) return;

    if (ev.id === "deepcraft:addxp") {
        addXP(ev.sourceEntity, parseInt(ev.message) || 1000);
    }
    if (ev.id === "deepcraft:quest") { acceptQuest(ev.sourceEntity, ev.message); }
    if (ev.id === "deepcraft:give") { giveCustomItem(ev.sourceEntity, ev.message); }
    if (ev.id === "deepcraft:summon") { summonBoss(ev.sourceEntity, ev.message); }
    if (ev.id === "deepcraft:max") {
        const player = ev.sourceEntity;
        for (const key in CONFIG.STATS) player.setDynamicProperty(`deepcraft:${key}`, 100);
        player.setDynamicProperty("deepcraft:level", 100);
        player.setDynamicProperty("deepcraft:ether", 1000);
        applyStatsToEntity(player);
        player.sendMessage("§e§l[DEBUG] ALL STATS MAXED!");
    }
});

// ==========================================
//  ⚔️ Combat Logic (Direct HP Manipulation)
// ==========================================

world.afterEvents.entityHurt.subscribe((ev) => {
    const victim = ev.hurtEntity;
    const attacker = ev.damageSource.damagingEntity;
    const damageAmount = ev.damage;

    // 1. 無敵時間 & ループ防止 (0.5秒クールダウン)
    const tick = system.currentTick;
    const lastHurtTick = victim.getDynamicProperty("deepcraft:last_hurt_tick") || 0;
    
    // 10tick以内なら処理しない (バニラダメージは入ってしまうので回復だけして終わるのが理想だが、
    // ここでは単純に処理をスキップする。バニラの無敵時間と同期させるため)
    if (tick - lastHurtTick < 10) return;
    
    // 更新
    victim.setDynamicProperty("deepcraft:last_hurt_tick", tick);

    // 2. バニラダメージの帳消し (回復)
    const hp = victim.getComponent("minecraft:health");
    if (!hp || hp.currentValue <= 0) return; 
    
    // 「受けたダメージ分」を回復して、HPを元に戻す
    hp.setCurrentValue(Math.min(hp.currentValue + damageAmount, hp.effectiveMax));

    // 3. ダメージ計算
    let finalDamage = 0;
    let isCritical = false;

    if (attacker && attacker.typeId === "minecraft:player") {
        // 攻撃者のステータスを計算
        const attackerStats = calculateEntityStats(attacker);
        
        // なまくらチェック
        const equipment = attacker.getComponent("equippable");
        const mainHand = equipment.getEquipment(EquipmentSlot.Mainhand);
        if (!checkReq(attacker, mainHand).valid) {
            attacker.playSound("random.break");
            finalDamage = 1; // ペナルティ
        } else {
            let attack = attackerStats.atk;

            // クリティカル判定
            if (Math.random() < attackerStats.critChance) {
                isCritical = true;
                attack *= attackerStats.critMult;
            }
            finalDamage = attack;
        }

        // 吸血
        if (attacker.hasTag("talent:vampirism")) {
            const aHp = attacker.getComponent("minecraft:health");
            if (aHp && aHp.currentValue > 0) aHp.setCurrentValue(Math.min(aHp.currentValue + 2, aHp.effectiveMax));
        }

    } else {
        // Mobからの攻撃はバニラダメージをベースにする（もしくはMob用ステータス定義を使う）
        finalDamage = damageAmount; 
    }

    if (victim.typeId === "minecraft:player") {
        // 防御者のステータスを計算
        const victimStats = calculateEntityStats(victim);

        // 回避 (Evasion)
        // 基礎15% + Agi補正
        let evasionChance = 0;
        if (victim.hasTag("talent:evasion")) evasionChance += 0.15;
        evasionChance += ((victim.getDynamicProperty("deepcraft:agility")||0) * 0.001);

        if (Math.random() < evasionChance) {
            victim.playSound("random.orb");
            victim.sendMessage("§aDodge!");
            return; // 完全回避
        }

        // 最終ダメージ = 攻撃力 - 防御力 (減算方式)
        finalDamage = Math.max(CONFIG.COMBAT.MIN_DAMAGE, finalDamage - victimStats.def);

        // 反射 (Thorns)
        if (attacker) {
            if (victim.hasTag("talent:thorns_aura")) attacker.applyDamage(2);
            if (victim.hasTag("talent:thorns_master")) attacker.applyDamage(Math.floor(finalDamage * 0.3));
        }
    }

    // 4. ダメージ適用 (HP直接操作)
    finalDamage = Math.floor(finalDamage);
    
    if (finalDamage > 0) {
        const newHp = hp.currentValue - finalDamage;

        if (newHp > 0) {
            // 生存する場合: HPを直接書き換える (画面揺れなし、イベント連鎖なし)
            hp.setCurrentValue(newHp);
            
            // クリティカル演出
            if (isCritical) {
                victim.dimension.playSound("random.anvil_land", victim.location, { pitch: 2.0 });
                victim.dimension.spawnParticle("minecraft:critical_hit_emitter", {
                    x: victim.location.x,
                    y: victim.location.y + 1,
                    z: victim.location.z
                });
                if (attacker && attacker.typeId === "minecraft:player") {
                    attacker.sendMessage(`§c§lCRITICAL! §r§6${finalDamage} Dmg`);
                }
            }
        } else {
            // トドメを刺す場合: applyDamageを使ってキルログを残す
            // ※直前にHPを1にしてから特大ダメージを与えて確実に殺す
            hp.setCurrentValue(1);
            // ループ防止用tickはセット済みなので、このapplyDamageがループすることはない(はずだが念のため)
            victim.applyDamage(9999); 
        }
    }
});

function getEquipmentStats(itemStack) {
    if (!itemStack) return { atk: 0, def: 0 };
    const id = itemStack.getDynamicProperty("deepcraft:item_id");
    if (!id) return { atk: 0, def: 0 };
    const def = EQUIPMENT_POOL[id];
    if (!def || !def.stats) return { atk: 0, def: 0 };
    return def.stats;
}

// --- Helper Functions (Quest, Profile, etc) ---
// (以下、変更なし。前回のコードと同じ)

world.afterEvents.entityDie.subscribe((ev) => {
    const victim = ev.deadEntity;
    const attacker = ev.damageSource.damagingEntity;

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
                    attacker.sendMessage(`§aQuest Completed: ${def.name}`);
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
                        attacker.sendMessage(`§eBoss Defeated! +${drop.amount} XP`);
                    }
                    if (drop.type === "item") {
                        const itemDef = EQUIPMENT_POOL[drop.id];
                        if (itemDef) {
                            const item = new ItemStack(itemDef.baseItem, 1);
                            item.nameTag = itemDef.name;
                            item.setLore(itemDef.lore);
                            item.setDynamicProperty("deepcraft:item_id", drop.id);
                            attacker.dimension.spawnItem(item, victim.location);
                            attacker.sendMessage(`§6§lRARE DROP! §rYou found: ${itemDef.name}`);
                        }
                    }
                });
            }
        }
        if (attacker.hasTag("talent:exp_boost")) addXP(attacker, 50);
    }

    if (victim.typeId === "minecraft:player") {
        const player = victim;
        const lostXP = player.getDynamicProperty("deepcraft:xp") || 0;
        player.setDynamicProperty("deepcraft:xp", 0);
        if (lostXP > 0) player.sendMessage(`§cYou died and lost ${lostXP} XP...`);

        const inventory = player.getComponent("inventory").container;
        const location = player.location;
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
        if (droppedItems.length > 0) {
            const spawnLoc = { x: location.x, y: location.y + 1.0, z: location.z };
            try {
                const soul = player.dimension.spawnEntity("minecraft:chest_minecart", spawnLoc);
                soul.nameTag = "§bSoul";
                const soulContainer = soul.getComponent("inventory").container;
                droppedItems.forEach(item => soulContainer.addItem(item));
                player.sendMessage(`§bItems dropped in Soul at [${Math.floor(spawnLoc.x)}, ${Math.floor(spawnLoc.y)}, ${Math.floor(spawnLoc.z)}].`);
            } catch (e) {}
        }
    }
});

function acceptQuest(player, questId) {
    const def = QUEST_POOL[questId];
    if (!def) { player.sendMessage(`§cQuest not found: ${questId}`); return; }
    const questData = JSON.parse(player.getDynamicProperty("deepcraft:quest_data") || "{}");
    if (questData[questId]) { player.sendMessage("§cAlready accepted or completed."); return; }
    questData[questId] = { status: "active", progress: 0 };
    player.setDynamicProperty("deepcraft:quest_data", JSON.stringify(questData));
    player.sendMessage(`§aQuest Accepted: ${def.name}`);
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
    player.sendMessage("§6Reward Claimed!");
    openQuestMenu(player);
}

function giveCustomItem(player, itemId) {
    const def = EQUIPMENT_POOL[itemId];
    if (!def) { player.sendMessage(`§cItem not found: ${itemId}`); return; }
    const item = new ItemStack(def.baseItem, 1);
    item.nameTag = def.name;
    item.setLore(def.lore);
    item.setDynamicProperty("deepcraft:item_id", itemId);
    player.getComponent("inventory").container.addItem(item);
    player.sendMessage(`§eReceived: ${def.name}`);
}

function summonBoss(player, bossId) {
    const def = MOB_POOL[bossId];
    if (!def) { player.sendMessage(`§cBoss ID not found.`); return; }
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
        player.sendMessage(`§c§lWARNING: ${def.name} has appeared!`);
        player.playSound("mob.enderdragon.growl");
    } catch (e) { player.sendMessage(`§cError: ${e}`); }
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

    if (regenAmount > 0 && hp && hp.currentValue < hp.effectiveMax && hp.currentValue > 0) {
        hp.setCurrentValue(Math.min(hp.currentValue + regenAmount, hp.effectiveMax));
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

function applyStatsToEntity(player) {
    const stats = {};
    for (const key in CONFIG.STATS) stats[key] = player.getDynamicProperty(`deepcraft:${key}`) || 0;

    let baseHealth = 18 + (stats.fortitude * 2);
    if (player.hasTag("talent:vitality_1")) baseHealth += 4;
    if (player.hasTag("talent:vitality_2")) baseHealth += 10;
    if (player.hasTag("talent:glass_cannon")) baseHealth = Math.floor(baseHealth * 0.5);

    const healthVal = Math.min(Math.max(baseHealth, 18), 300); 
    player.triggerEvent(`health${healthVal}`);

    try { player.setProperty("status:arrow_damage", stats.light); } catch (e) {}
    
    if (player.hasTag("talent:heavy_stance")) player.triggerEvent("knockback_resistance100");
    else player.triggerEvent("knockback_resistance_reset");

    let speedIndex = 10 + Math.floor(stats.agility * 0.2); 
    if (player.hasTag("talent:swift_1")) speedIndex += 5; 
    if (player.hasTag("talent:godspeed")) speedIndex += 15;
    if (player.hasTag("debuff:heavy_armor")) speedIndex = Math.max(5, speedIndex - 10);

    speedIndex = Math.min(Math.max(speedIndex, 0), 300);
    player.triggerEvent(`movement${speedIndex}`);
    player.triggerEvent("attack1");
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
}

function openMenuHub(player) {
    const form = new ChestFormData("small");
    form.title("§lMenu Hub");
    const pendingDraws = player.getDynamicProperty("deepcraft:pending_card_draws") || 0;
    const activeProfile = player.getDynamicProperty("deepcraft:active_profile") || 1;

    form.button(2, "§b§lView Talents", ["§r§7Check unlocked talents"], "minecraft:enchanted_book");
    if (pendingDraws > 0) {
        form.button(4, "§6§l🎁 DRAW TALENT", ["§r§eUnclaimed Talents!", "§cClick to draw", "§8(Status menu locked)"], "minecraft:nether_star", pendingDraws, 0, true);
    } else {
        form.button(4, "§a§lStatus & Upgrade", ["§r§7Manage stats"], "minecraft:experience_bottle");
    }
    form.button(6, `§d§lProfile: Slot ${activeProfile}`, ["§r§7Switch Builds"], "minecraft:name_tag");
    // ★追加: 詳細ステータス確認
    form.button(13, "§d§l📊 View Details", ["§r§7Check ATK, DEF, Crit..."], "minecraft:spyglass");
    
    form.button(20, "§6§lQuest Log", ["§r§7Active quests"], "minecraft:writable_book");
    form.button(26, "§c§lDEBUG: RESET", ["§r§cReset Profile"], "minecraft:barrier");
    form.button(25, "§e§lDEBUG: +XP", ["§r+1000 XP"], "minecraft:emerald");
    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 4) pendingDraws > 0 ? openCardSelection(player) : openStatusMenu(player);
        if (res.selection === 2) openTalentViewer(player);
        if (res.selection === 6) openProfileMenu(player);
        if (res.selection === 13) openDetailStats(player); // ★
        if (res.selection === 20) openQuestMenu(player);
        if (res.selection === 26) resetCurrentProfile(player);
        if (res.selection === 25) { addXP(player, 1000); openMenuHub(player); }
    });
}

// ★追加: 詳細ステータス表示メニュー
function openDetailStats(player) {
    const stats = calculateEntityStats(player);
    const form = new ChestFormData("small");
    form.title("§lCharacter Details");
    
    form.button(10, `§c§lATK: ${stats.atk}`, ["§7Physical Attack Power"], "minecraft:iron_sword");
    form.button(11, `§b§lDEF: ${stats.def}`, ["§7Damage Reduction"], "minecraft:shield");
    form.button(12, `§e§lCrit Rate: ${(stats.critChance * 100).toFixed(1)}%`, ["§7Critical Hit Chance"], "minecraft:gold_nugget");
    form.button(13, `§6§lCrit Dmg: ${(stats.critMult * 100).toFixed(0)}%`, ["§7Critical Damage Multiplier"], "minecraft:blaze_powder");
    form.button(14, `§3§lEther: ${stats.maxEther}`, [`§7Regen: ${stats.etherRegen}/s`], "minecraft:phantom_membrane");
    form.button(15, `§f§lSpeed: ${(stats.speed * 100).toFixed(0)}%`, ["§7Movement Speed"], "minecraft:feather");
    
    form.button(26, "§c§lBack", ["§rReturn to Hub"], "minecraft:barrier");
    form.show(player).then(res => {
        if (!res.canceled && res.selection === 26) openMenuHub(player);
    });
}

function openProfileMenu(player) {
    const form = new ChestFormData("small");
    form.title("§lProfile Manager");
    const activeSlot = player.getDynamicProperty("deepcraft:active_profile") || 1;
    for (let i = 1; i <= CONFIG.MAX_PROFILES; i++) {
        const isCurrent = (i === activeSlot);
        const slotJson = player.getDynamicProperty(`deepcraft:profile_${i}`);
        let desc = "§7Empty / Default";
        let level = 1;
        if (slotJson) { try { const data = JSON.parse(slotJson); level = data.level || 1; desc = `§7Level: ${level}\n§7Traits: ${data.talents.length}`; } catch(e) {} }
        const uiPos = 9 + (i * 2);
        let icon = isCurrent ? "minecraft:ender_chest" : "minecraft:chest";
        let name = isCurrent ? `§a§lSlot ${i} (Active)` : `§lSlot ${i}`;
        form.button(uiPos, name, [desc, isCurrent ? "§a[Current]" : "§e[Click to Load]"], icon, level);
    }
    form.button(26, "§c§lBack", ["§rReturn to Hub"], "minecraft:barrier");
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
            player.sendMessage(`§aLoaded Profile Slot ${targetSlot}.`);
            openMenuHub(player);
        } else if (targetSlot === activeSlot) { player.sendMessage("§cAlready active."); openProfileMenu(player); }
    });
}

function openStatusMenu(player) {
    const form = new ChestFormData("large");
    const level = player.getDynamicProperty("deepcraft:level");
    const invested = player.getDynamicProperty("deepcraft:invested_points");
    const remaining = CONFIG.STAT_POINTS_PER_LEVEL - invested;
    const currentXP = player.getDynamicProperty("deepcraft:xp");
    const cost = getXpCostForLevel(level);
    
    let titleText = `§lStatus | Pts to LvUp: ${remaining}`;
    if (level >= 20) {
        titleText = `§lStatus | Bonus Pts: ${remaining} (Max Lv)`;
        if (remaining <= 0) titleText = `§lStatus | §a§lFULLY MAXED`;
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
        
        let lore = [`§r§7Lv: §f${val}`, `§r§eCost: ${cost} XP`, `§r§8(Click to Upgrade)`];
        if (key === "intelligence") lore.push(`§bMax Ether: +${Math.floor(val * CONFIG.ETHER_PER_INT)}`);
        if (key === "willpower") lore.push(`§bEther Regen++`);
        if (val >= 100) lore = [`§r§a§lMAXED (100)`];

        form.button(slot, `§l${name}`, lore, icon, val);
        slotToKeyMap[slot] = key;
    });
    form.button(53, "§c§lBack", ["§rBack to Hub"], "minecraft:barrier");
    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 53) { openMenuHub(player); return; }
        const selectedKey = slotToKeyMap[res.selection];
        if (selectedKey) upgradeStat(player, selectedKey);
    });
}

function openTalentViewer(player) {
    const form = new ChestFormData("large");
    form.title("§lOwned Talents");
    let slot = 0;
    const tags = player.getTags();
    CARD_POOL.forEach(card => {
        if (tags.includes(`talent:${card.id}`)) {
            form.button(slot, card.name, [card.description, `§oRarity: ${card.rarity}`], "minecraft:enchanted_book");
            slot++;
        }
    });
    if (slot === 0) form.button(22, "§7No Talents", ["§rYou have no talents yet."], "minecraft:barrier");
    form.button(53, "§c§lBack", ["§rBack to Hub"], "minecraft:barrier");
    form.show(player).then(res => { if (!res.canceled && res.selection === 53) openMenuHub(player); });
}

function openQuestMenu(player) {
    const form = new ChestFormData("large");
    form.title("§lQuest Log");
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
        if (userQuest.status === "active") { icon = "minecraft:book"; statusText = `§7Progress: §f${userQuest.progress} / ${def.amount}`; clickText = "§8(In Progress)"; }
        else if (userQuest.status === "completed") { icon = "minecraft:emerald"; statusText = "§a§lCOMPLETED!"; clickText = "§e[Click to Claim Reward]"; isGlint = true; }
        else if (userQuest.status === "claimed") { icon = "minecraft:paper"; statusText = "§8(Reward Claimed)"; clickText = "§8Done"; }
        form.button(slot, def.name, [def.description, statusText, clickText], icon, 1, 0, isGlint);
        questIds[slot] = qId;
        slot++;
    });
    if (slot === 0) form.button(22, "§7No Active Quests", ["§rExplore to find quests!"], "minecraft:barrier");
    form.button(53, "§c§lBack", ["§rReturn to Hub"], "minecraft:barrier");
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
    
    if (level >= 20 && invested >= CONFIG.STAT_POINTS_PER_LEVEL) {
        player.playSound("note.bass");
        player.sendMessage("§a§lYou have reached the absolute limit of power!");
        openStatusMenu(player);
        return;
    }

    const currentXP = player.getDynamicProperty("deepcraft:xp");
    const cost = getXpCostForLevel(level);
    
    const currentVal = player.getDynamicProperty(`deepcraft:${statKey}`) || 0;
    if (currentVal >= 100) {
        player.playSound("note.bass");
        player.sendMessage(`§c${CONFIG.STATS[statKey]} is already at max level (100)!`);
        openStatusMenu(player);
        return;
    }

    if (currentXP < cost) { 
        player.sendMessage(`§cNot enough XP! Need: ${cost}, Have: ${currentXP}`); 
        openStatusMenu(player); 
        return; 
    }

    player.setDynamicProperty("deepcraft:xp", currentXP - cost);
    player.setDynamicProperty(`deepcraft:${statKey}`, currentVal + 1);
    player.setDynamicProperty("deepcraft:invested_points", invested + 1);
    
    player.playSound("random.levelup");
    player.sendMessage(`§aUpgraded: ${CONFIG.STATS[statKey]} -> ${currentVal + 1}`);
    applyStatsToEntity(player);

    if (invested + 1 >= CONFIG.STAT_POINTS_PER_LEVEL) {
        if (level < 20) {
            processLevelUp(player);
        } else {
            player.sendMessage("§6§lMAX LEVEL BONUS COMPLETE! §r(Stats: 300/300)");
            player.playSound("ui.toast.challenge_complete");
            system.runTimeout(() => openMenuHub(player), 20);
        }
    } else {
        openStatusMenu(player);
    }
}

function processLevelUp(player) {
    const currentLvl = player.getDynamicProperty("deepcraft:level");
    player.setDynamicProperty("deepcraft:level", currentLvl + 1);
    player.setDynamicProperty("deepcraft:invested_points", 0);
    let pending = player.getDynamicProperty("deepcraft:pending_card_draws") || 0;
    player.setDynamicProperty("deepcraft:pending_card_draws", pending + 1);
    player.sendMessage(`§6§lLEVEL UP! §r(Lv.${currentLvl + 1})`);
    player.playSound("ui.toast.challenge_complete");
    system.runTimeout(() => openMenuHub(player), 20);
}

function openCardSelection(player) {
    const form = new ChestFormData("small");
    form.title("§lSelect a Talent");
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
        form.button(positions[index], card.name, [card.description, `§o${card.rarity.toUpperCase()}`, `§8Req: ${card.conditionText}`], icon, 1, 0, true);
    });
    form.show(player).then((response) => {
        if (response.canceled) { player.sendMessage("§cPlease select a talent."); openMenuHub(player); return; }
        const idx = positions.indexOf(response.selection);
        if (idx !== -1 && selection[idx]) { applyCardEffect(player, selection[idx]); }
    });
}

function applyCardEffect(player, card) {
    let pending = player.getDynamicProperty("deepcraft:pending_card_draws") || 0;
    if (pending > 0) player.setDynamicProperty("deepcraft:pending_card_draws", pending - 1);
    player.sendMessage(`§aAcquired Talent: ${card.name}`);
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
    player.sendMessage(`§c[DEBUG] Profile Slot ${currentSlot} has been reset.`);
}