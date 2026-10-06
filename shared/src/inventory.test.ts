import { describe, expect, it } from "vitest";
import { ammoTarget, giveWeapon, magIn, reserveIn, resetInventory, weaponIn } from "./inventory";
import { Player } from "./state";
import { WEAPONS, WEAPON_NONE, WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN, WEAPON_SMG } from "./weapons";

function fresh() {
  const p = new Player();
  resetInventory(p);
  return p;
}

describe("inventory", () => {
  it("starts with a loaded pistol and an empty slot", () => {
    const p = fresh();
    expect([weaponIn(p, 0), weaponIn(p, 1)]).toEqual([WEAPON_PISTOL, WEAPON_NONE]);
    expect(magIn(p, 0)).toBe(WEAPONS[WEAPON_PISTOL].mag);
    expect(ammoTarget(p)).toBe(-1); // the pistol doesn't take ammo
  });

  it("fills the empty slot first and switches to it", () => {
    const p = fresh();
    expect(giveWeapon(p, WEAPON_SMG, 90)).toBeNull();
    expect(p.slot).toBe(1);
    expect(weaponIn(p, 1)).toBe(WEAPON_SMG);
    expect(magIn(p, 1)).toBe(WEAPONS[WEAPON_SMG].mag);
    expect(reserveIn(p, 1)).toBe(90);
  });

  it("replaces the pistol before a real weapon, without dropping it", () => {
    const p = fresh();
    giveWeapon(p, WEAPON_SMG, 90); // slot 1 active
    expect(giveWeapon(p, WEAPON_RIFLE, 15)).toBeNull();
    expect([weaponIn(p, 0), weaponIn(p, 1)]).toEqual([WEAPON_RIFLE, WEAPON_SMG]);
    expect(p.slot).toBe(0);
  });

  it("swaps out the active weapon when both slots hold real weapons", () => {
    const p = fresh();
    giveWeapon(p, WEAPON_SMG, 90);
    giveWeapon(p, WEAPON_RIFLE, 15); // rifle in slot 0, active
    const dropped = giveWeapon(p, WEAPON_SHOTGUN, 18);
    expect(dropped).toEqual({ weapon: WEAPON_RIFLE, reserve: 15 + WEAPONS[WEAPON_RIFLE].mag });
    expect([weaponIn(p, 0), weaponIn(p, 1)]).toEqual([WEAPON_SHOTGUN, WEAPON_SMG]);
  });

  it("sends ammo to a weapon that uses it", () => {
    const p = fresh();
    giveWeapon(p, WEAPON_SMG, 0);
    p.slot = 0; // holding the pistol
    expect(ammoTarget(p)).toBe(1);
  });
});
