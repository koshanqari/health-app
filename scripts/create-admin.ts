import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { auth } from "../src/lib/auth";
import { db } from "../src/lib/db";

async function readPassword(): Promise<string> {
  if (!stdin.isTTY) throw new Error("Use an interactive terminal or provide ADMIN_PASSWORD in your environment.");
  stdout.write("Password (at least 12 characters): ");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };
    const onData = (data: Buffer) => {
      for (const char of data.toString()) {
        if (char === "\u0003") { finish(); reject(new Error("Cancelled.")); return; }
        if (char === "\r" || char === "\n") { finish(); resolve(value); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); }
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

try {
  let name = process.env.ADMIN_NAME;
  let email = process.env.ADMIN_EMAIL;
  if (!name || !email) {
    if (!stdin.isTTY) throw new Error("Provide ADMIN_NAME, ADMIN_EMAIL, and ADMIN_PASSWORD, or run in a terminal.");
    const prompt = createInterface({ input: stdin, output: stdout });
    name ||= await prompt.question("Administrator name: ");
    email ||= await prompt.question("Email address: ");
    prompt.close();
  }
  const password = process.env.ADMIN_PASSWORD || await readPassword();
  if (password.length < 12 || password.length > 128) throw new Error("Use a password between 12 and 128 characters.");
  if (!name.trim() || !email.trim()) throw new Error("Name and email are required.");

  const result = await auth.api.signUpEmail({
    body: { name: name.trim(), email: email.trim().toLowerCase(), password },
  });
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("UPDATE \"user\" SET role = 'admin' WHERE id = $1", [result.user.id]);
    await connection.execute("DELETE FROM \"session\" WHERE \"userId\" = $1", [result.user.id]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  console.log("Administrator created. Sign in at /admin/login.");
} catch (error) {
  const message = error instanceof Error ? error.message : "Unable to create administrator.";
  console.error(message);
  process.exitCode = 1;
} finally {
  await db.end();
}
