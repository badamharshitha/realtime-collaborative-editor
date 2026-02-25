const express = require("express");
const cors = require("cors");
require("dotenv").config();
const pool = require("./db");
const { WebSocketServer } = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.APP_PORT || 8080;

/* ============================
   IN-MEMORY SESSIONS
============================ */
const sessions = {};
// {
//   documentId: {
//     content: string,
//     version: number,
//     clients: Map(ws => { userId, username })
//   }
// }

/* ============================
   HEALTH
============================ */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK" });
});

/* ============================
   INIT DATABASE
============================ */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER DEFAULT 0
    );
  `);
  console.log("Documents table ready");
}
initDB();

/* ============================
   REST APIs
============================ */
app.post("/api/documents", async (req, res) => {
  const { title, content } = req.body;

  const result = await pool.query(
    "INSERT INTO documents (title, content) VALUES ($1, $2) RETURNING *",
    [title, content]
  );

  res.status(201).json(result.rows[0]);
});

app.get("/api/documents", async (req, res) => {
  const result = await pool.query(
    "SELECT id, title FROM documents ORDER BY id ASC"
  );
  res.status(200).json(result.rows);
});

app.get("/api/documents/:id", async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(
    "SELECT * FROM documents WHERE id = $1",
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ message: "Document not found" });
  }

  res.status(200).json(result.rows[0]);
});

app.delete("/api/documents/:id", async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(
    "DELETE FROM documents WHERE id = $1 RETURNING *",
    [id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ message: "Document not found" });
  }

  res.status(204).send();
});

/* ============================
   START SERVER
============================ */
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

/* ============================
   WEBSOCKET
============================ */
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", async (message) => {
    let data;

    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.log("Invalid JSON received");
      return;
    }

    /* ============================
       JOIN
    ============================ */
    if (data.type === "JOIN") {
      const { documentId, userId, username } = data;

      console.log(`JOIN received for document ${documentId}`);

      // Load document into session if not active
      if (!sessions[documentId]) {
        const result = await pool.query(
          "SELECT * FROM documents WHERE id = $1",
          [documentId]
        );

        if (result.rows.length === 0) {
          console.log("Document not found in DB");
          return;
        }

        sessions[documentId] = {
          content: result.rows[0].content,
          version: result.rows[0].version,
          clients: new Map(),
        };
      }

      const session = sessions[documentId];

      session.clients.set(ws, { userId, username });

      // Send INIT
      ws.send(
        JSON.stringify({
          type: "INIT",
          content: session.content,
          version: session.version,
          users: Array.from(session.clients.values()),
        })
      );

      // Notify others
      session.clients.forEach((client, clientWs) => {
        if (clientWs !== ws && clientWs.readyState === 1) {
          clientWs.send(
            JSON.stringify({
              type: "USER_JOINED",
              userId,
              username,
            })
          );
        }
      });
    }

    /* ============================
       OPERATION
    ============================ */
    if (data.type === "OPERATION") {
      console.log("OPERATION received:", data);

      const { documentId, userId, operation, clientVersion } = data;

      const session = sessions[documentId];

      if (!session) {
        console.log("No active session for document");
        return;
      }

      let { content, version } = session;

      console.log("Server version:", version, "Client version:", clientVersion);

      if (clientVersion !== version) {
        console.log("Version mismatch");
        return;
      }

      // Apply operation
      if (operation.type === "insert") {
        content =
          content.slice(0, operation.position) +
          operation.text +
          content.slice(operation.position);
      }

      if (operation.type === "delete") {
        content =
          content.slice(0, operation.position) +
          content.slice(operation.position + operation.length);
      }

      // Update session
      session.content = content;
      session.version++;

      console.log("New content:", session.content);
      console.log("New version:", session.version);

      // Persist to DB
      await pool.query(
        "UPDATE documents SET content = $1, version = $2 WHERE id = $3",
        [session.content, session.version, documentId]
      );

      // Broadcast to other clients
      session.clients.forEach((client, clientWs) => {
        if (clientWs !== ws && clientWs.readyState === 1) {
          clientWs.send(
            JSON.stringify({
              type: "OPERATION",
              userId,
              operation,
              serverVersion: session.version,
            })
          );
        }
      });
    }
  });

  ws.on("close", () => {
    console.log("WebSocket disconnected");

    // Remove client from sessions
    for (const documentId in sessions) {
      const session = sessions[documentId];

      if (session.clients.has(ws)) {
        const { userId, username } = session.clients.get(ws);
        session.clients.delete(ws);

        // Broadcast USER_LEFT
        session.clients.forEach((client, clientWs) => {
          if (clientWs.readyState === 1) {
            clientWs.send(
              JSON.stringify({
                type: "USER_LEFT",
                userId,
                username,
              })
            );
          }
        });
      }
    }
  });
});
