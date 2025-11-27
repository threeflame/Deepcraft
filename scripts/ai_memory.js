// BP/scripts/ai_memory.js

/*
==========================================================================
 🧠 AI CONTEXT MEMORY (DeepCraft Development Log)
 Version: 17.0 (Virtual HP, Market & Anti-Combat Log Complete)
==========================================================================

## 1. Project Overview
- **Title**: DeepCraft
- **Concept**: Deepwoken-inspired PvPvE RPG (Hardcore / Stat Building).
- **Environment**: Minecraft BE Script API.
- **Library**: Chest-UI.

## 2. ⚠️ Technical Constraints & Ban List (絶対に使用禁止)
1.  **[BANNED] `world.beforeEvents.entityHurt`**: 動作不安定のため使用禁止。全て `afterEvents` で処理する。
2.  **[BANNED] `world.afterEvents.chatSend`**: チャットコマンド廃止。`/scriptevent` を使用する。
3.  **[BANNED] `entity.playSound()`**: Mobにメソッドがないため `dimension.playSound` を使用する。
4.  **[BANNED] Separate `processLevelUp` Function**:
    * **理由**: データ保存のタイミングが分散し、ポイント消失や無限化バグの原因になる。
    * **解決策**: レベルアップ処理は `upgradeStat` 内でアトミック（一括）に行うこと。

## 3. 🛡️ Critical Implementation Rules (修正時・上書き禁止事項)
以下のロジックはバグ修正の末に確立された「正解」であり、変更してはならない。

### A. System Loop & HUD Stability
- **Update Frequency**: `system.runInterval` は **10 tick (0.5秒)** を維持する。
  - 理由: 2 tick (0.1秒) ではクライアントの描画が追いつかず、HUDが点滅・消失するため。
- **Loop Safety**: ループ内（`forEach`）の処理は必ず個別に `try-catch` で囲むこと。

### B. Level Up Logic (`upgradeStat`)
- **Atomic Update**: ポイント加算とレベルアップ判定は同時に行い、`setDynamicProperty` は分岐後に**1回だけ**実行する。
- **Reset Requirement**: 投資ポイント(`invested_points`)が15に達したら、**必ず `0` を保存する**。

### C. HP System (Virtual HP)
- **Vanilla HP**: `player.json` で **200** (ハート100個) に固定。
- **Damage Handling**: `entityHurt` の**一番最初**に `resetToMax()` を実行し、バニラダメージを帳消しにする。
- **Virtual HP**: スクリプト上の `deepcraft:hp` を計算で減算する。
- **Death**: 仮想HP <= 0 で `kill` コマンドを実行（`applyDamage`では死なないため）。

### D. Combat & Desync Fixes
- **I-Frame**: スクリプトによる無敵時間管理は**廃止**（バニラ準拠）。
- **Combat Mode**:
  - **ログアウト対策**: `beforeEvents.playerLeave` で即座にアイテムをSoulとして排出し、フラグを立てる。次回ログイン時に処刑する。
  - **リセット**: 死亡時(`entityDie`)およびログアウト処刑時(`playerSpawn`)に、必ず `combat_timer` を `0` にリセットする（無限キルループ防止）。

## 4. Current Mechanics / 現在の仕様

### Stats & Progression
- **Max Level**: 20.
- **Stat Points**: 15 points per level. Total **300**.
- **Stat Cap**: 100 per stat.
- **Initial Stats**: All 0.

### Economy
- **Currency**: Gold (`deepcraft:gold`).
- **Market**: Global listing system using chunked dynamic properties.
  - Listing via: Menu button (Hand item) OR Command `/scriptevent deepcraft:sell <price>`.

### Content
- **Soul**: Spawns on death/logout. Stores owner ID (`deepcraft:owner_id`).
- **Bosses**: 3 Custom Bosses. HP bar on NameTag.
- **Equipment**: Custom `atk`/`def` calculation.

==========================================================================
*/