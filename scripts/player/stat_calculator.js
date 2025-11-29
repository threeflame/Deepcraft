// BP/scripts/player/stat_calculator.js
import { EquipmentSlot } from "@minecraft/server";
import { CONFIG } from "../config.js";
import { EQUIPMENT_POOL } from "../data/equipment.js";
import { MOB_POOL } from "../data/mobs.js";

export function calculateEntityStats(entity) { // exportされていることを確認
    const stats = {
        atk: 0, def: 0, critChance: CONFIG.COMBAT.BASE_CRIT_CHANCE, critMult: CONFIG.COMBAT.BASE_CRIT_MULT,
        speed: 1.0, maxEther: CONFIG.ETHER_BASE, etherRegen: CONFIG.ETHER_REGEN_BASE, maxHP: 100, evasion: 0,
        details: { atk: [], def: [], critChance: [], critMult: [], ether: [], regen: [], speed: [], evasion: [] }
    };

    const addDetail = (key, source, value, isRate = false, isMult = false) => {
        if (value === 0) return;
        let valStr = isMult ? `x${value.toFixed(1)}` : isRate ? `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%` : `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
        stats.details[key].push(`§7${source}: §f${valStr}`);
    };

    addDetail('critChance', '基礎値', CONFIG.COMBAT.BASE_CRIT_CHANCE, true);
    addDetail('critMult', '基礎値', CONFIG.COMBAT.BASE_CRIT_MULT, true);
    addDetail('ether', '基礎値', CONFIG.ETHER_BASE);
    addDetail('regen', '基礎値', CONFIG.ETHER_REGEN_BASE);
    addDetail('speed', '基礎値', 1.0, false, true);

    if (entity.typeId === "minecraft:player") {
        calculatePlayerStats(entity, stats, addDetail);
    } else {
        calculateMobStats(entity, stats);
    }
    return stats;
}

function calculatePlayerStats(player, stats, addDetail) {
    const p = (prop) => player.getDynamicProperty(prop) || 0;
    const str = p("deepcraft:strength"), fort = p("deepcraft:fortitude"), agi = p("deepcraft:agility");
    const int = p("deepcraft:intelligence"), will = p("deepcraft:willpower"), defStat = p("deepcraft:defense");
    let level = p("deepcraft:level");
    if (level < 1) level = 1;

    const equip = player.getComponent("equippable");
    const equipStats = { atk: 0, def: 0 };
    equipStats.atk += getEquipmentStats(equip.getEquipment(EquipmentSlot.Mainhand)).atk;
    [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet].forEach(slot => {
        equipStats.def += getEquipmentStats(equip.getEquipment(slot)).def;
    });

    // ATK
    let atk = level + (str * 0.5) + equipStats.atk;
    addDetail('atk', 'レベル', level);
    addDetail('atk', '筋力(Str)', str * 0.5);
    addDetail('atk', '武器', equipStats.atk);
    if (player.hasTag("talent:brute_force")) { atk += 2; addDetail('atk', 'Brute Force', 2); }
    if (player.hasTag("talent:glass_cannon")) { atk *= 1.5; addDetail('atk', 'Glass Cannon', 1.5, false, true); }
    if (player.hasTag("talent:sharp_blade")) { atk *= 1.1; addDetail('atk', 'Sharp Blade', 1.1, false, true); }
    const hpRatio = (p("deepcraft:hp") / p("deepcraft:max_hp")) || 1;
    if (player.hasTag("talent:berserker") && hpRatio < 0.3) { atk *= 1.5; addDetail('atk', 'Berserker', 1.5, false, true); }
    if (player.hasTag("talent:assassin") && player.isSneaking) { atk *= 2.0; addDetail('atk', 'Assassin', 2.0, false, true); }
    stats.atk = Math.floor(atk);

    // Crit
    const agiCrit = agi * 0.001, intCrit = int * 0.0005;
    stats.critChance += agiCrit + intCrit;
    addDetail('critChance', '敏捷(Agi)', agiCrit, true);
    addDetail('critChance', '知性(Int)', intCrit, true);
    if (player.hasTag("talent:eagle_eye")) { stats.critChance += 0.1; addDetail('critChance', 'Eagle Eye', 0.1, true); }
    const strCritMult = str * 0.005;
    stats.critMult += strCritMult;
    addDetail('critMult', '筋力(Str)', strCritMult, true);

    // DEF
    let def = defStat + (fort * CONFIG.COMBAT.DEFENSE_CONSTANT) + equipStats.def;
    addDetail('def', '防御(Def)', defStat);
    addDetail('def', '不屈(Fort)', fort * CONFIG.COMBAT.DEFENSE_CONSTANT);
    addDetail('def', '防具', equipStats.def);
    if (player.hasTag("talent:tough_skin")) { def += 2; addDetail('def', 'Tough Skin', 2); }
    if (player.hasTag("talent:iron_wall")) { def += 5; addDetail('def', 'Iron Wall', 5); }
    if (player.hasTag("talent:last_stand") && hpRatio < 0.3) { def *= 1.5; addDetail('def', 'Last Stand', 1.5, false, true); }
    stats.def = Math.floor(def);

    // Ether
    const intEther = int * CONFIG.ETHER_PER_INT;
    stats.maxEther += intEther;
    addDetail('ether', '知性(Int)', intEther);
    const willRegen = will * CONFIG.ETHER_REGEN_PER_WILL;
    stats.etherRegen += willRegen;
    addDetail('regen', '意志(Will)', willRegen);

    // HP
    let hp = 20 + (fort * 2);
    if (player.hasTag("talent:vitality_1")) hp += 4;
    if (player.hasTag("talent:vitality_2")) hp += 10;
    if (player.hasTag("talent:glass_cannon")) hp = Math.floor(hp * 0.5);
    stats.maxHP = Math.floor(hp);

    // Speed
    let speedBonus = (Math.floor(agi * 0.2) / 100);
    addDetail('speed', '敏捷(Agi)', speedBonus, true);
    let speedMult = 1.0 + speedBonus;
    if (player.hasTag("talent:swift_1")) { speedMult += 0.05; addDetail('speed', 'Swiftness', 0.05, true); }
    if (player.hasTag("talent:godspeed")) { speedMult += 0.15; addDetail('speed', 'Godspeed', 0.15, true); }
    if (player.hasTag("debuff:heavy_armor")) { speedMult -= 0.1; addDetail('speed', '重量過多', -0.1, true); }
    stats.speed = speedMult;

    // Evasion
    const agiEvasion = agi * 0.001;
    stats.evasion += agiEvasion;
    addDetail('evasion', '敏捷(Agi)', agiEvasion, true);
    if (player.hasTag("talent:evasion")) { stats.evasion += 0.15; addDetail('evasion', 'Evasion', 0.15, true); }
}

function calculateMobStats(mob, stats) {
    let maxHP = mob.getDynamicProperty("deepcraft:max_hp");
    if (maxHP === undefined) {
        const bossId = mob.getDynamicProperty("deepcraft:boss_id");
        if (bossId && MOB_POOL[bossId]) {
            maxHP = MOB_POOL[bossId].health;
        } else {
            const hpComp = mob.getComponent("minecraft:health");
            maxHP = hpComp ? hpComp.effectiveMax * 10 : 200;
        }
        mob.setDynamicProperty("deepcraft:max_hp", maxHP);
        mob.setDynamicProperty("deepcraft:hp", maxHP);
    }
    stats.maxHP = maxHP;
    stats.atk = 50; // Default mob attack
    stats.def = 0;  // Default mob defense
}

export function getEquipmentStats(itemStack) {
    if (!itemStack) return { atk: 0, def: 0 };
    const id = itemStack.getDynamicProperty("deepcraft:item_id");
    if (!id) return { atk: 0, def: 0 };
    const def = EQUIPMENT_POOL[id];
    if (!def || !def.stats) return { atk: 0, def: 0 };
    return def.stats;
}