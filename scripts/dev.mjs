import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev:server"], { stdio: "inherit", env: process.env }),
  spawn("npm", ["run", "dev:client"], { stdio: "inherit", env: process.env }),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const exitCodes = await Promise.all(children.map((child) => new Promise((resolve) => child.on("exit", resolve))));
process.exitCode = exitCodes.some((code) => code !== 0 && code !== null) ? 1 : 0;
