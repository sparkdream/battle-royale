import { createServer } from "./app";
import { web3 } from "./chain";

const PORT = Number(process.env.PORT ?? 2567);

// Connect the relayer and find the game's artifact classes (no-op when off).
void web3.init();

const server = createServer({ serveClient: process.env.NODE_ENV === "production" });
await server.listen(PORT);
console.log(`Game server listening on http://localhost:${PORT}`);
