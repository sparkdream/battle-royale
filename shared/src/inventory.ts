import type { Player } from "./state";
import { WEAPONS, WEAPON_NONE, WEAPON_PISTOL } from "./weapons";

// Slot accessors: the schema stores the two slots as separate fields.

export function weaponIn(p: Player, slot: number): number {
  return slot === 0 ? p.w0 : p.w1;
}

export function magIn(p: Player, slot: number): number {
  return slot === 0 ? p.mag0 : p.mag1;
}

export function reserveIn(p: Player, slot: number): number {
  return slot === 0 ? p.res0 : p.res1;
}

export function activeWeapon(p: Player): number {
  return weaponIn(p, p.slot);
}

export function setSlotContents(p: Player, slot: number, weapon: number, mag: number, reserve: number) {
  if (slot === 0) {
    p.w0 = weapon;
    p.mag0 = mag;
    p.res0 = reserve;
  } else {
    p.w1 = weapon;
    p.mag1 = mag;
    p.res1 = reserve;
  }
}

export function setMag(p: Player, slot: number, mag: number) {
  if (slot === 0) p.mag0 = mag;
  else p.mag1 = mag;
}

export function setReserve(p: Player, slot: number, reserve: number) {
  if (slot === 0) p.res0 = reserve;
  else p.res1 = reserve;
}

/** Fresh inventory: a loaded pistol and an empty second slot. */
export function resetInventory(p: Player) {
  setSlotContents(p, 0, WEAPON_PISTOL, WEAPONS[WEAPON_PISTOL].mag, 0);
  setSlotContents(p, 1, WEAPON_NONE, 0, 0);
  p.slot = 0;
  p.medkits = 0;
  p.reloading = false;
  p.healing = false;
}

export interface DroppedWeapon {
  weapon: number;
  reserve: number;
}

/**
 * Put a picked-up weapon in an empty slot, or in place of the active weapon.
 * Returns what got displaced so the caller can drop it (pistols just vanish).
 */
export function giveWeapon(p: Player, weapon: number, reserve: number): DroppedWeapon | null {
  let slot = p.w0 === WEAPON_NONE ? 0 : p.w1 === WEAPON_NONE ? 1 : p.slot;
  // Never throw away a real weapon while the pistol is sitting in the other slot.
  if (p.w0 !== WEAPON_NONE && p.w1 !== WEAPON_NONE && weaponIn(p, slot) !== WEAPON_PISTOL
      && weaponIn(p, 1 - slot) === WEAPON_PISTOL) {
    slot = 1 - slot;
  }
  const old = weaponIn(p, slot);
  const dropped = old !== WEAPON_NONE && old !== WEAPON_PISTOL
    ? { weapon: old, reserve: reserveIn(p, slot) + magIn(p, slot) }
    : null;
  setSlotContents(p, slot, weapon, WEAPONS[weapon].mag, reserve);
  p.slot = slot;
  return dropped;
}

/** Spare rounds an ammo pickup adds; goes to the active weapon if it uses ammo, else the other one. */
export function ammoTarget(p: Player): number {
  for (const slot of [p.slot, 1 - p.slot]) {
    const w = weaponIn(p, slot);
    if (w !== WEAPON_NONE && WEAPONS[w].reserve > 0) return slot;
  }
  return -1;
}

export function ammoPickupAmount(weapon: number): number {
  return WEAPONS[weapon].mag * 2;
}

export function maxReserve(weapon: number): number {
  return WEAPONS[weapon].reserve * 3;
}
