// scripts/main.js
import { world, system } from "@minecraft/server";
import { startChaos } from "./chaos/bootstrap/index.js";

startChaos({ world, system });
