// BP/scripts/data/mobs.js

export const MOB_POOL = {
    "bandit_leader": {
        name: "§c§lBandit Leader",
        type: "minecraft:husk", 
        health: 60, 
        scale: 1.1, 
        speed: 0.3, 
        equipment: {
            mainhand: "soldier_blade",
            head: "minecraft:iron_helmet",
            chest: "minecraft:leather_chestplate",
            legs: "minecraft:iron_leggings",
            feet: "minecraft:leather_boots"
        },
        drops: [
            { type: "xp", amount: 500 },
            { type: "item", id: "soldier_blade", chance: 0.3 },
            { type: "item", id: "thief_dagger", chance: 0.3 }
        ],
        skills: [
            {
                id: "summon_minions",
                chance: 0.05, 
                msg: "§c野郎ども、やっちまえ！",
                action: (entity) => {
                    entity.dimension.spawnEntity("minecraft:zombie", entity.location);
                    entity.dimension.spawnEntity("minecraft:zombie", entity.location);
                    entity.dimension.playSound("mob.zombie.say", entity.location);
                }
            }
        ]
    },

    "corrupted_knight": {
        name: "§4§lCorrupted Knight",
        type: "minecraft:zombie_pigman", 
        health: 150,
        scale: 1.2,
        speed: 0.25,
        equipment: {
            mainhand: "heavy_claymore",
            head: "minecraft:netherite_helmet",
            chest: "minecraft:netherite_chestplate",
            legs: "minecraft:netherite_leggings",
            feet: "minecraft:netherite_boots"
        },
        drops: [
            { type: "xp", amount: 1500 },
            { type: "item", id: "heavy_claymore", chance: 0.2 },
            { type: "item", id: "battle_axe", chance: 0.3 }
        ],
        skills: [
            {
                id: "charge",
                chance: 0.08,
                msg: "§4§l突撃！！",
                action: (entity) => {
                    const view = entity.getViewDirection();
                    entity.applyKnockback(view.x, view.z, 5.0, 0.0); 
                    entity.addEffect("speed", 60, { amplifier: 4 });
                    entity.dimension.playSound("mob.ravager.roar", entity.location);
                }
            },
            {
                id: "ground_smash",
                chance: 0.05,
                msg: "§c粉砕！",
                action: (entity) => {
                    entity.dimension.spawnParticle("minecraft:large_explosion", entity.location);
                    entity.dimension.playSound("random.explode", entity.location);
                    
                    const players = entity.dimension.getPlayers({ location: entity.location, maxDistance: 5 });
                    players.forEach(p => {
                        p.applyDamage(10);
                        p.applyKnockback(0, 0, 3, 0.5);
                    });
                }
            }
        ]
    },

    "elder_lich": {
        name: "§5§lElder Lich",
        type: "minecraft:stray", 
        health: 100,
        scale: 1.0,
        speed: 0.2,
        equipment: {
            mainhand: "spell_blade",
            head: "minecraft:golden_helmet",
            chest: "minecraft:golden_chestplate"
        },
        drops: [
            { type: "xp", amount: 2500 },
            { type: "item", id: "spell_blade", chance: 0.25 },
            { type: "item", id: "flame_sword", chance: 0.1 }
        ],
        skills: [
            {
                id: "fireball_barrage",
                chance: 0.1, 
                msg: "§5灰となれ...",
                action: (entity) => {
                    for(let i=0; i<3; i++) {
                        const fb = entity.dimension.spawnEntity("minecraft:small_fireball", {
                            x: entity.location.x, y: entity.location.y + 2, z: entity.location.z
                        });
                        fb.applyImpulse({ x: (Math.random()-0.5)*2, y: (Math.random()-0.5)*2, z: (Math.random()-0.5)*2 });
                    }
                    entity.dimension.playSound("mob.ghast.shoot", entity.location);
                }
            },
            {
                id: "ice_nova",
                chance: 0.05,
                msg: "§b凍り付け！",
                action: (entity) => {
                    entity.dimension.spawnParticle("minecraft:snowflake_particle", entity.location);
                    const players = entity.dimension.getPlayers({ location: entity.location, maxDistance: 8 });
                    players.forEach(p => {
                        p.addEffect("slowness", 100, { amplifier: 3 });
                        p.applyDamage(5);
                    });
                    entity.dimension.playSound("random.glass", entity.location);
                }
            }
        ]
    }
};