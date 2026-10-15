/**
 * The bytes a match record is stored, served and hashed as. One function so
 * the profile store (which serves them) and the chain recorder (which puts
 * the hash on the match token) can never disagree.
 */

import { createHash } from "node:crypto";
import type { MatchRecord } from "@br/shared";

export function encodeMatchRecord(record: MatchRecord): { body: string; hash: string } {
  const body = JSON.stringify(record);
  return { body, hash: createHash("sha256").update(body).digest("hex") };
}

/** Match ids are 16 lowercase hex chars (see GameRoom.startDrop). */
export const MATCH_ID_RE = /^[0-9a-f]{16}$/;
