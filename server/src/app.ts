import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { defineRoom, defineServer } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  AUTH_NONCE_PATH, AUTH_VERIFY_PATH, CHAIN_STATUS_PATH, LEADERBOARD_PATH, LEADERBOARD_SIZE, MATCH_RECORD_PATH,
  WEB3_TOKENS_PATH,
} from "@br/shared";
import { GameRoom } from "./GameRoom";
import { web3 } from "./chain";
import { addressAuth } from "./instance";
import { MATCH_ID_RE } from "./matchRecord";
import { mergeBoards, profiles } from "./profiles";

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");

/** Operator-only funnel counts (see ProfileStore.funnel). */
export const FUNNEL_PATH = "/admin/funnel";

/** Constant-time comparison; hashing first makes the lengths equal. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** The game server, not yet listening. Tests create their own on a spare port. */
export function createServer({ serveClient = false } = {}) {
  return defineServer({
    transport: new WebSocketTransport(),
    greet: false,
    rooms: {
      // New players go where the most humans are, whatever its bot difficulty
      // (players change that in game). Rooms stay open mid-match: late joiners spectate.
      battle: defineRoom(GameRoom).sortBy({ clients: -1 }),
    },
    express: (app) => {
      // The dev client is served from another port, hence the CORS header.
      const cors = (res: express.Response) => res.set("Access-Control-Allow-Origin", "*");

      app.get("/health", (_req, res) => {
        res.send("ok");
      });

      // Whether web3 mode exists on this deployment, and how to reach the chain.
      app.get(CHAIN_STATUS_PATH, (_req, res) => {
        cors(res).json(web3.status());
      });

      // The client's own tokens, proxied so the browser never fights chain CORS.
      app.get(WEB3_TOKENS_PATH, async (req, res) => {
        cors(res);
        const address = String(req.query.address ?? "");
        if (!web3.enabled) return res.status(503).json({ error: "web3 disabled" });
        if (!address) return res.status(400).json({ error: "address required" });
        try {
          res.json({ tokens: await web3.playerTokens(address) });
        } catch (err) {
          res.status(502).json({ error: err instanceof Error ? err.message : "query failed" });
        }
      });

      // Wallet login: nonce → Keplr signArbitrary → verify.
      app.get(AUTH_NONCE_PATH, (req, res) => {
        cors(res);
        try {
          res.json({ nonce: addressAuth.issueNonce(String(req.query.address ?? "")) });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : "bad request" });
        }
      });
      app.options(AUTH_VERIFY_PATH, (_req, res) => {
        cors(res).set("Access-Control-Allow-Methods", "POST, OPTIONS").set("Access-Control-Allow-Headers", "Content-Type").send();
      });
      app.post(AUTH_VERIFY_PATH, express.json(), (req, res) => {
        cors(res);
        try {
          res.json({ ok: true, ticket: addressAuth.verify(req.body ?? {}) });
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : "verification failed" });
        }
      });

      // A finished match's full result: the document a match token's uri
      // points at, served byte-for-byte so its sha256 matches the token's uriHash.
      app.get(`${MATCH_RECORD_PATH}/:id`, (req, res) => {
        cors(res);
        const id = String(req.params.id);
        const body = MATCH_ID_RE.test(id) ? profiles.matchRecord(id) : null;
        if (body === null) return res.status(404).json({ error: "no such match" });
        res.type("application/json").send(body);
      });

      // The leaderboard: onchain career records when web3 mode is on (they win
      // name collisions — an address outranks a name), then the profiles of
      // everyone who plays without a wallet.
      app.get(LEADERBOARD_PATH, async (_req, res) => {
        cors(res);
        const local = profiles.top(LEADERBOARD_SIZE);
        if (!web3.enabled) return res.json(local);
        try {
          return res.json(mergeBoards(await web3.chainLeaderboard(LEADERBOARD_SIZE), local, LEADERBOARD_SIZE));
        } catch (err) {
          console.error("chain leaderboard unavailable:", err);
          return res.json(local);
        }
      });
      // Funnel counts for the operator. Off unless ADMIN_TOKEN is set; then it
      // needs "Authorization: Bearer <ADMIN_TOKEN>".
      const adminToken = process.env.ADMIN_TOKEN;
      if (adminToken) {
        app.get(FUNNEL_PATH, (req, res) => {
          if (!sameSecret(req.get("authorization") ?? "", `Bearer ${adminToken}`)) {
            res.status(401).send("unauthorized");
            return;
          }
          res.json(profiles.funnel());
        });
      }
      // In production the server also serves the built client, so one process
      // and one port is the whole deployment.
      if (serveClient) app.use(express.static(clientDist));
    },
  });
}
