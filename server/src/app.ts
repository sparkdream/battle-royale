import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { defineRoom, defineServer } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom";

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");

/** The game server, not yet listening. Tests create their own on a spare port. */
export function createServer({ serveClient = false } = {}) {
  return defineServer({
    transport: new WebSocketTransport(),
    greet: false,
    rooms: {
      // Separate rooms per bot difficulty.
      battle: defineRoom(GameRoom).filterBy(["difficulty"]),
    },
    express: (app) => {
      app.get("/health", (_req, res) => {
        res.send("ok");
      });
      // In production the server also serves the built client, so one process
      // and one port is the whole deployment.
      if (serveClient) app.use(express.static(clientDist));
    },
  });
}
