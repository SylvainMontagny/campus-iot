const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validatePassword, hashPassword, verifyPassword, readPasswordHash, writePasswordHash, removePasswordHash } = require("../src/auth/service");

test("password validation has a 256-character maximum and no minimum", () => {
  assert.equal(validatePassword("", ""), null);
  assert.equal(validatePassword("x".repeat(256), "x".repeat(256)), null);
  assert.equal(validatePassword("x".repeat(257), "x".repeat(257)), "Password must not exceed 256 characters.");
  assert.equal(validatePassword("password", "different"), "Password confirmation does not match.");
});

test("stores a salted password hash without storing the password", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campus-iot-auth-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const password = "correct horse battery staple";

  const passwordHash = await hashPassword(password);
  assert.notEqual(passwordHash, password);
  assert.match(passwordHash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword("incorrect password", passwordHash), false);

  await writePasswordHash(passwordHash, directory);
  assert.equal(await readPasswordHash(directory), passwordHash);
  const fileContent = await fs.readFile(path.join(directory, "auth.json"), "utf8");
  assert.equal(fileContent.includes(password), false);
  await removePasswordHash(directory);
  assert.equal(await readPasswordHash(directory), null);
});

test("rejects malformed stored password hashes", async () => {
  assert.equal(await verifyPassword("some password", "plain-text"), false);
});

test("password hashing handles long values independently of API validation", async () => {
  const password = "long password ".repeat(30);
  const passwordHash = await hashPassword(password);
  assert.equal(await verifyPassword(password, passwordHash), true);
  assert.equal(await verifyPassword(`${password}x`, passwordHash), false);
});
