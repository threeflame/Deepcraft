// BP/scripts/ai_memory.js

/*
==========================================================================
 🧠 AI CONTEXT MEMORY (DeepCraft Development Log)
 Version: 19.0 (Combat Log Fix & Partial Drop System Complete)
==========================================================================

## 1. Project Overview
- **Title**: DeepCraft
- **Concept**: Deepwoken-inspired PvPvE RPG (Hardcore / Stat Building).
- **Environment**: Minecraft BE Script API 1.13.0+
- **Library**: Chest-UI (Menu System).
- **GameRule Requirement**: `keepInventory` must be **TRUE**.

## 2. ⚠️ Technical Constraints & Ban List (修正時・使用禁止事項)
1.  **[BANNED] `world.beforeEvents.entityHurt`**: 動作不安定のため使用禁止。全て `afterEvents` で処理する。
2.  **[BANNED] `world.beforeEvents.playerLeave` for Spawning**:
    * **理由**: 読み取り専用コンテキストのため、エンティティ生成やインベントリ変更ができない。
    * **解決策**: `system.runInterval` で常時バックアップを取り、`afterEvents.playerLeave` で生成する。
3.  **[BANNED] `processLevelUp` Function Separation**:
    * **理由**: 処理が分散するとデータ保存タイミングがズレてバグる。
    * **解決策**: レベルアップ処理は `upgradeStat` 内でアトミック（一括）に行う。
4.  **[BANNED] Player Scaling**:
    * **理由**: Hitbox Desync（判定ズレ）の主原因となるため、`player.json` からスケール関連の定義は全削除済み。

## 3. 🛡️ Critical Implementation Rules (基幹システムの正解ロジック)

### A. HP System (Virtual HP)
- **Vanilla HP**: `player.json` で **200** (ハート100個) に固定。
- **Damage Handling**: `entityHurt` の**冒頭**で `resetToMax()` を実行し、バニラダメージを帳消しにする。
- **Virtual HP**: スクリプト上の `deepcraft:hp` を計算結果で減算する。
- **Death**: 仮想HP <= 0 で `kill` コマンドを実行。
- **Respawn**: `playerSpawn` 時に仮想HPを最大値にリセットする（無限死防止）。

### B. Level Up Logic
- **Atomic Update**: 
    - ポイント加算後に `if (next >= 15)` で分岐。
    - レベルアップ時は `invested_points` に **必ず `0` を保存**。
    - 途中なら加算した値を保存。
    - これらを1つの関数内で行う。

### C. Combat Mode & Anti-Combat Log
- **Trigger**: 攻撃/被弾時にタイマー(20s)セット。
- **Backup System**: 戦闘中(0.5秒毎)にインベントリと座標を `COMBAT_LOG_CACHE` に保存。
- **Disconnect Penalty**:
    - ログアウト検知(`afterEvents.playerLeave`)時、キャッシュがあればSoulを生成し、ワールドに処刑フラグ(`combat_log:<id>`)を保存。
    - 次回ログイン時(`playerSpawn`)、フラグがあればインベントリ全没収＆3秒後に処刑。

### D. Death Mechanics (Soul)
- **Keep Inventory**: ゲームルールでONにする（散らばり防止）。
- **Partial Drop**:
    - **Hotbar (0-8), Armor, Offhand**: ドロップしない（確定キープ）。
    - **Inventory (9-35)**: 各アイテムごとに確率で抽選。
        - 当選 -> Soulに移動（インベントリから削除）。
        - 落選 -> 手元に残る。
    - Soul生成位置は `y + 1.0`。

## 4. Current Mechanics / 現在の仕様

### Stats & Progression
- **Max Level**: 20 (Total 300 pts).
- **Stats**: 14 types (Max 100). Used for requirements.
- **Ether**: Regens 10% of rate every 0.1s.

### Economy
- **Currency**: Gold (`deepcraft:gold`).
- **Market**: Global listing via chunked dynamic properties.
  - Selling: Hand-held item only.
  - Buying: Menu UI.

### Content Data
- **Equipment**: `equipment.js` (atk, def, req, skill).
- **Talents**: `talents.js` (conditions, passive effects).
- **Bosses**: `mobs.js` (AI skills, HP bar on NameTag).

==========================================================================
*/