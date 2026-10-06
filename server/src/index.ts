import { createServer } from "./app";

const PORT = Number(process.env.PORT ?? 2567);

const server = createServer({ serveClient: process.env.NODE_ENV === "production" });
await server.listen(PORT);
console.log(`Game server listening on http://localhost:${PORT}`);
