const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const appRoot = path.join(__dirname, "..", "..");
const sqlDir = path.join(appRoot, "sql");
const scriptsDir = path.join(appRoot, "scripts");

const sqlFileOrder = [
  "station-initial.sql",
  "places-initial.sql",
  "trains-initial.sql",
];

async function getInitialSqlFiles() {
  const entries = await fs.promises.readdir(sqlDir);
  const sqlFiles = entries.filter((name) => name.endsWith("-initial.sql"));
  if (sqlFiles.length === 0) {
    throw new Error("No initial SQL files found in sql/");
  }

  const ordered = sqlFileOrder.filter((name) => sqlFiles.includes(name));
  const remaining = sqlFiles
    .filter((name) => !sqlFileOrder.includes(name))
    .sort();
  return ordered.concat(remaining);
}

async function runSqlFile(client, fileName) {
  const filepath = path.join(sqlDir, fileName);
  const rawSql = await fs.promises.readFile(filepath, "utf8");
  const statements = rawSql
    .split(/;\s*(?:\r?\n|$)/)
    .map((stmt) => stmt.trim())
    .filter(Boolean);

  if (statements.length === 0) {
    return { fileName, statements: 0 };
  }

  await client.query("BEGIN");
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
    return { fileName, statements: statements.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Failed to execute ${fileName}: ${err.message}`);
  }
}

async function runAllInitialSqlFiles() {
  const files = await getInitialSqlFiles();
  const client = await SqlService.pool.connect();
  try {
    const results = [];
    for (const fileName of files) {
      LogService.info(`Running initial SQL file: ${fileName}`);
      const result = await runSqlFile(client, fileName);
      results.push(result);
    }
    return results;
  } finally {
    client.release();
  }
}

async function runScript(scriptName) {
  const scriptPath = path.join(scriptsDir, scriptName);
  const command = process.execPath;
  const args = [scriptPath];
  const options = {
    cwd: appRoot,
    env: process.env,
  };

  LogService.info(`Running script: ${scriptName}`);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(command, args, options);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        LogService.info(`Script ${scriptName}: ${line}`);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        LogService.error(`Script ${scriptName}: ${line}`);
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start ${scriptName}: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const message = `Script ${scriptName} exited with code ${code}`;
        return reject(new Error(message));
      }
      resolve({
        scriptName,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function runSyncScripts() {
  const scriptList = [
    "sync-stations.js",
    "sync-popular-stations.js",
    "sync-trains-list.js",
    "sync-train-details.js",
  ];

  const results = [];
  for (const scriptName of scriptList) {
    results.push(await runScript(scriptName));
  }
  return results;
}

module.exports = {
  runInitialSqlAndScripts: async (req, res, next) => {
    try {
      const sqlResults = await runAllInitialSqlFiles();
      const scriptResults = await runSyncScripts();

      return res.status(200).json({
        message: "Initialization completed successfully.",
        sqlResults,
        scriptResults,
      });
    } catch (err) {
      LogService.error(err);
      return next(err);
    }
  },
};
