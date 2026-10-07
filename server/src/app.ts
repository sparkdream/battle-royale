import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { defineRoom, defineServer } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { LEADERBOARD_PATH, LEADERBOARD_SIZE } from "@br/shared";
import { GameRoom } from "./GameRoom";
import { leaderboard } from "./leaderboard";

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");

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
      app.get("/health", (_req, res) => {
        res.send("ok");
      });
      // The dev client is served from another port, hence the CORS header.
      app.get(LEADERBOARD_PATH, (_req, res) => {
        res.set("Access-Control-Allow-Origin", "*").json(leaderboard.top(LEADERBOARD_SIZE));
      });
      // In production the server also serves the built client, so one process
      // and one port is the whole deployment.
      if (serveClient) app.use(express.static(clientDist));
    },
  });
}
