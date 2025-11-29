// BP/scripts/systems/item_handler.js
import { ItemStack, EquipmentSlot, system } from "@minecraft/server";
import { openMenuHub } from "../ui/ui_manager.js";
import { EQUIPMENT_POOL } from "../data/equipment.js";
import { checkReq } from "../player/player_manager.js";
import { executeSkill } from "../player/skill_manager.js";
import { MOB_POOL } from "../data/mobs.js";
import { calculateEntityStats } from "../player/stat_calculator.js";

export function handleItemUse(event) {
    const player = event.source;
    const item = event.itemStack;

    // [提案] runTimeoutの動作確認テスト
    if (item.typeId === "minecraft:stick") {
        try {
            player.sendMessage("§e3秒後にメッセージが表示されるかテストします...");
            system.runTimeout(() => {
                if (player.isValid()) {
                    player.sendMessage("§a§lテスト成功！ system.runTimeout は正常に動作しています。");
                }
            }, 60); // 3秒 = 60 ticks
        } catch (e) {
            player.sendMessage(`§c§lテスト失敗！ system.runTimeout は利用できません。`);
            player.sendMessage(`§cエラー: ${e}`);
        }
        return; // テストを実行したら他の処理はしない
    }

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
}

/**
 * プレイヤーにカスタムアイテムを与える
 * @param {import("@minecraft/server").Player} player 
 * @param {string} itemId 
 * @param {boolean} [isSellable=false] マーケットで販売可能にするか
 */
export function giveCustomItem(player, itemId, isSellable = false) {
    const def = EQUIPMENT_POOL[itemId];
    if (!def) { player.sendMessage(`§cアイテムが見つかりません: ${itemId}`); return; }
    const item = createCustomItem(itemId, isSellable);
    player.getComponent("inventory").container.addItem(item);
    player.sendMessage(`§e入手: ${def.name}${isSellable ? " §a(販売可能)" : ""}`);
}

export function summonBoss(player, bossId) {
    const def = MOB_POOL[bossId];
    if (!def) { player.sendMessage(`§cボスIDが見つかりません。`); return; }
    try {
        const boss = player.dimension.spawnEntity(def.type, player.location);
        boss.addTag("deepcraft:boss"); // カスタムMobを識別するための汎用タグ
        boss.setDynamicProperty("deepcraft:boss_id", bossId);
        boss.nameTag = def.name;

        const health = boss.getComponent("minecraft:health");
        if (health) {
            // ★変更: 耐性ではなく、ヘルスブーストで最大HPを大幅に引き上げて不死身にする
            boss.addEffect("health_boost", 20000000, { amplifier: 255, showParticles: false });
            // 現在のHPを新しい最大値に設定
            health.resetToMaxValue();
        }

        const equip = boss.getComponent("equippable");
        if (equip && def.equipment) {
            Object.entries(def.equipment).forEach(([slot, itemId]) => {
                equip.setEquipment(slot, createCustomItem(itemId));
            });
        }
        // ★追加: 召喚時にステータスを初期化し、HPバーを即時表示させる
        calculateEntityStats(boss);

        player.sendMessage(`§c§l警告: ${def.name} が出現しました！`);
        player.playSound("mob.enderdragon.growl");
    } catch (e) { player.sendMessage(`§cエラー: ${e}`); }
}

/**
 * カスタムアイテムのItemStackを生成する
 * @param {string} itemId 
 * @param {boolean} [isSellable=false] マーケットで販売可能にするか
 * @returns {ItemStack}
 */
export function createCustomItem(itemId, isSellable = false) {
    const def = EQUIPMENT_POOL[itemId];
    if (!def) return new ItemStack(itemId, 1);
    const item = new ItemStack(def.baseItem, 1);
    item.nameTag = def.name;
    item.setLore(def.lore);
    item.setDynamicProperty("deepcraft:item_id", itemId);
    if (isSellable) item.setDynamicProperty("deepcraft:sellable", true);
    return item;
}