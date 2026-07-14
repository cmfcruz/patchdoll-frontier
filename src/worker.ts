import { provider } from "./config.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { startProviderWorker } from "./providerWorker.js";

const localProvider = provider === "claude" ? claudeProvider : codexProvider;
await startProviderWorker(localProvider);
