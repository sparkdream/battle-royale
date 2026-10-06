export interface Weapon {
  name: string;
  damage: number; // per pellet
  cooldownTicks: number;
  speed: number; // px/s
  range: number; // px
  spread: number; // max radians either side of the aim
  pellets: number;
  mag: number;
  reloadTicks: number;
  /** Spare rounds a pickup comes with; 0 means unlimited (the pistol). */
  reserve: number;
  color: number;
}

export const WEAPON_PISTOL = 0;
export const WEAPON_SMG = 1;
export const WEAPON_SHOTGUN = 2;
export const WEAPON_RIFLE = 3;
/** Empty inventory slot. */
export const WEAPON_NONE = 255;

export const WEAPONS: readonly Weapon[] = [
  { name: "Pistol", damage: 14, cooldownTicks: 8, speed: 1100, range: 700, spread: 0.03, pellets: 1, mag: 12, reloadTicks: 30, reserve: 0, color: 0xffe08a },
  { name: "SMG", damage: 9, cooldownTicks: 3, speed: 1150, range: 600, spread: 0.09, pellets: 1, mag: 30, reloadTicks: 48, reserve: 90, color: 0x8fd3ff },
  { name: "Shotgun", damage: 10, cooldownTicks: 24, speed: 950, range: 380, spread: 0.22, pellets: 7, mag: 6, reloadTicks: 66, reserve: 18, color: 0xffa36b },
  { name: "Rifle", damage: 48, cooldownTicks: 30, speed: 2000, range: 1400, spread: 0.004, pellets: 1, mag: 5, reloadTicks: 60, reserve: 15, color: 0xe08aff },
];

// Loot types 1..3 are the weapon with that id; the rest are consumables.
export const LOOT_MEDKIT = 10;
export const LOOT_ARMOR = 11;
export const LOOT_AMMO = 12;

export function isWeaponLoot(type: number): boolean {
  return type > WEAPON_PISTOL && type < WEAPONS.length;
}

export function lootName(type: number): string {
  if (isWeaponLoot(type)) return WEAPONS[type].name;
  if (type === LOOT_MEDKIT) return "Medkit";
  if (type === LOOT_ARMOR) return "Armor";
  if (type === LOOT_AMMO) return "Ammo";
  return "?";
}
