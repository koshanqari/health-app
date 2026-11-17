import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const action = process.argv[2];
if (action !== "up" && action !== "down") throw new Error("Choose up or down.");
const desktopCli = join(homedir(), ".docker", "bin", "docker");
const docker = existsSync(desktopCli) ? desktopCli : "docker";
try {
  execFileSync(docker, ["compose", "--env-file", ".env.local", ...(existsSync(".env.postgres.local") ? ["--env-file", ".env.postgres.local"] : []), ...(action === "up" ? ["up", "-d", "--wait", "postgres"] : ["stop", "postgres"])], { stdio: "inherit" });
} catch {
  console.error("Start Docker Desktop and check .env.local, then try again.");
  process.exitCode = 1;
}
