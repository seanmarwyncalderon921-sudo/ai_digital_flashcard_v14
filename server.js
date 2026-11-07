import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import sqlite3 from "sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import Groq from "groq-sdk";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "831508871993-j7egn200ai4uvbqabkuka6s66juaikes.apps.googleusercontent.com";
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-20b";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "llama-3.2-11b-vision-preview";

let firebaseAdminReady = false;
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    })
  });
  firebaseAdminReady = true;
} else {
  console.warn("Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.");
}

// --- CLIENT INITIALIZATIONS ---
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const groqClients = new Map();

function getGroqClient(subjectMode) {
  const key = subjectMode === "math"
    ? process.env.GROQ_API_KEY_MATH || process.env.GROQ_API_KEY
    : subjectMode === "filipino"
      ? process.env.GROQ_API_KEY_FILIPINO || process.env.GROQ_API_KEY
      : process.env.GROQ_API_KEY;
  if (!key) {
    throw new Error("AI generation is not configured. Set GROQ_API_KEY in the server environment.");
  }
  if (!groqClients.has(key)) {
    groqClients.set(key, new Groq({ apiKey: key }));
  }
  return groqClients.get(key);
}

// --- SQLITE DATABASE SETUP ---
const dbFile = path.join(__dirname, "sapc_flashcards.db");
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error("SQLite Connection Error:", err.message);
  } else {
    console.log("Connected to local SQLite database successfully.");
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT,
      googleId TEXT,
      picture TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      title TEXT NOT NULL,
      subjectMode TEXT DEFAULT 'general',
      gradeLevel TEXT DEFAULT 'Grade 11',
      academicStrand TEXT DEFAULT 'Section 1',
      cards TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_decks_userId ON decks(userId);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ai_prompt_usage (
      userId INTEGER PRIMARY KEY,
      promptCount INTEGER NOT NULL DEFAULT 0,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

function reserveAiPrompt(userId) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO ai_prompt_usage (userId, promptCount) VALUES (?, 1)
       ON CONFLICT(userId) DO UPDATE SET promptCount = promptCount + 1, updatedAt = CURRENT_TIMESTAMP`,
      [userId],
      error => {
        if (error) return reject(error);
        db.get("SELECT promptCount FROM ai_prompt_usage WHERE userId = ?", [userId], (selectError, row) => {
          if (selectError) return reject(selectError);
          resolve(Number(row?.promptCount || 0));
        });
      }
    );
  });
}

// --- EXPRESS MIDDLEWARE ---
app.use(cors());
app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

// Required security headers to allow Google popup communication
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const publicDir = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public")
  : __dirname;
app.use(express.static(publicDir));

// --- JWT AUTHENTICATION MIDDLEWARE ---
async function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token required." });
  }

  try {
    if (firebaseAdminReady) {
      const decoded = await admin.auth().verifyIdToken(token);
      req.user = { userId: decoded.uid, uid: decoded.uid, email: decoded.email };
      return next();
    }

    if (!JWT_SECRET) {
      return res.status(503).json({ error: "Firebase authentication is not configured on the server." });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) return res.status(403).json({ error: "Invalid or expired token." });
      req.user = user;
      next();
    });
  } catch (err) {
    console.error("Authentication Error:", err.message);
    return res.status(403).json({ error: "Invalid or expired token." });
  }
}

function isPasswordComplex(password) {
  const minLength = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  return minLength && hasUpper && hasLower && hasNumber && hasSpecial;
}

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    if (!isPasswordComplex(password)) {
      return res.status(400).json({ 
        error: "Password must be at least 8 characters long and contain uppercase, lowercase, number, and special character." 
      });
    }

    db.get("SELECT id FROM users WHERE username = ?", [username.trim()], async (err, row) => {
      if (err) {
        return res.status(500).json({ error: "Database error during registration." });
      }
      if (row) {
        return res.status(400).json({ error: "Username is already taken." });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      db.run(
        "INSERT INTO users (username, password) VALUES (?, ?)",
        [username.trim(), hashedPassword],
        function(insertErr) {
          if (insertErr) {
            return res.status(500).json({ error: "Failed to create user account." });
          }
          return res.status(201).json({ message: "User registered successfully!" });
        }
      );
    });

  } catch (err) {
    console.error("Register Error:", err);
    return res.status(500).json({ error: "Internal server error during registration." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required." });
    }

    db.get("SELECT * FROM users WHERE username = ?", [username.trim()], async (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: "Invalid username or password." });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ error: "Invalid username or password." });
      }

      const token = jwt.sign(
        { userId: user.id, username: user.username },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({
        token,
        username: user.username,
        picture: user.picture
      });
    });

  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({ error: "Internal server error during login." });
  }
});

// Google Authentication Route
app.post("/api/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: "Google credential token required." });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    db.get("SELECT * FROM users WHERE googleId = ? OR email = ?", [googleId, email], async (err, user) => {
      if (err) return res.status(500).json({ error: "Database error during Google login." });

      if (!user) {
        const dummyPassword = await bcrypt.hash(googleId + JWT_SECRET, 10);
        const username = name || email.split("@")[0];
        db.run(
          "INSERT INTO users (username, email, password, googleId, picture) VALUES (?, ?, ?, ?, ?)",
          [username, email, dummyPassword, googleId, picture],
          function(insertErr) {
            if (insertErr) return res.status(500).json({ error: "Failed to create Google user." });
            const newUserId = this.lastID;
            const token = jwt.sign({ userId: newUserId, username }, JWT_SECRET, { expiresIn: "7d" });
            return res.json({ token, username, picture });
          }
        );
      } else {
        if (!user.googleId) {
          db.run("UPDATE users SET googleId = ?, picture = ? WHERE id = ?", [googleId, picture, user.id]);
        }
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
        return res.json({ token, username: user.username, picture: user.picture || picture });
      }
    });

  } catch (err) {
    console.error("Google Auth Error:", err);
    return res.status(401).json({ error: "Google authentication failed." });
  }
});

app.get("/api/auth/me", authenticateToken, (req, res) => {
  db.get("SELECT id, username, email, picture, createdAt FROM users WHERE id = ?", [req.user.userId], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: "User not found." });
    }
    return res.json(user);
  });
});

// ==========================================
// GROQ AI FLASHCARD GENERATION ROUTE (Protected)
// ==========================================

app.post("/api/flashcards", authenticateToken, async (req, res) => {
  try {
    const promptCount = await reserveAiPrompt(req.user.userId);
    if (promptCount > 150) {
      return res.status(429).json({ error: "AI prompt limit reached. You can use up to 150 generation prompts." });
    }
    const {
      notes = "",
      count = 10,
      images = [],
      gradeLevel = "Grade 11",
      academicStrand = "General",
      difficulty = "medium",
      subjectMode = "general"
    } = req.body;
    const requestedCount = Math.min(150, Math.max(1, Number(count) || 10));

    const hasImages = Array.isArray(images) && images.length > 0;

    if (!notes.trim() && !hasImages) {
      return res.status(400).json({ error: "Please provide study notes or attached files." });
    }

    const systemPrompt = `
You are an expert educational reviewer generator tailored for Senior High School students in the Philippines (${gradeLevel} - ${academicStrand}).
Generate ${requestedCount} flashcards based strictly on the provided study material.

STRICT JSON OUTPUT FORMAT:
Output ONLY raw valid JSON with key "cards" containing an array of objects. Do not include markdown formatting or backticks.

CARD TYPE SCHEMAS:
1. Identification ("type": "identification"):
   - "question": Clean, direct question asking to identify a key term or concept.
   - "answer": Clean, exact term, phrase, or acronym (e.g., "Presentation Layer" or "DNA"). NEVER include "Answer:", "Key:", numbers, or definitions inside "answer".
   - "explanation": Brief supporting explanation of the answer.

2. Multiple Choice ("type": "multiple-choice"):
   - "question": Question followed by choice options on new lines formatted as:
     Question text here?
     A. Option 1
     B. Option 2
     C. Option 3
     D. Option 4
   - "answer": "A. Option 1"
   - "explanation": Why the choice is correct.

3. Enumeration ("type": "enumeration"):
   - Use ONLY when asking to list 2 or more distinct items.
   - "question": "List the layers of..."
   - "answer": Multi-line string with items numbered (e.g., "1. Item A\\n2. Item B").

4. True or False ("type": "true-false"):
   - "question": Direct statement text.
   - "answer": "True" or "False" (or "Tama" / "Mali" if subjectMode is filipino).
   - "explanation": Brief explanation.

CRITICAL RULES FOR QUESTIONS:
- NEVER leak internal prompts, hints, rephrasings, or meta-instructions inside parentheses inside the question string.
- Return clean, direct questions only.
`;

    const textInstruction = `
Subject Focus: ${subjectMode.toUpperCase()}
Target Difficulty: ${difficulty}
${notes.trim() ? `Study Notes Material:\n${notes}` : "Extract all study material from the attached file(s) and generate the flashcards."}
`;

    const activeGroqClient = getGroqClient(subjectMode);
    const modelName = hasImages ? GROQ_VISION_MODEL : GROQ_TEXT_MODEL;
    let messages;

    if (hasImages) {
      const userContent = [{ type: "text", text: systemPrompt + "\n\n" + textInstruction }];

      images.slice(0, 5).forEach((img) => {
        if (img.data && img.mimeType) {
          userContent.push({
            type: "image_url",
            image_url: {
              url: `data:${img.mimeType};base64,${img.data}`
            }
          });

          app.post("/api/ai-hint", authenticateToken, async (req, res) => {
            try {
              const { question, answer, subjectMode = "general" } = req.body;
              if (typeof question !== "string" || typeof answer !== "string" || !question.trim() || !answer.trim()) {
                return res.status(400).json({ error: "A question and answer are required." });
              }
              const response = await getGroqClient(subjectMode).chat.completions.create({
                model: GROQ_TEXT_MODEL,
                temperature: 0.4,
                messages: [
                  { role: "system", content: "Give a short educational hint without revealing the answer. Use one or two sentences." },
                  { role: "user", content: `Question: ${question}\nCorrect answer: ${answer}` }
                ]
              });
              return res.json({ hint: response.choices[0]?.message?.content?.trim() || "Think about the key concept from your notes." });
            } catch (err) {
              console.error("AI Hint Route Error:", err);
              return res.status(500).json({ error: "Failed to generate an AI hint." });
            }
          });
        }
      });

      messages = [{ role: "user", content: userContent }];
    } else {
      messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: textInstruction }
      ];
    }

    const response = await activeGroqClient.chat.completions.create({
      model: modelName,
      messages: messages,
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    const rawContent = response.choices[0]?.message?.content || "{}";
    const cleanedJson = rawContent.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsedData = JSON.parse(cleanedJson);

    if (!parsedData.cards || !Array.isArray(parsedData.cards)) {
      throw new Error("Invalid card structure returned from AI model.");
    }

    return res.json({ cards: parsedData.cards });

  } catch (err) {
    console.error("AI Generation Route Error:", err);
    return res.status(500).json({ error: err.message || "Failed to generate flashcards." });
  }
});

// ==========================================
// SAVED DECKS MANAGEMENT ROUTES (CRUD)
// ==========================================

app.get("/api/decks", authenticateToken, (req, res) => {
  db.all("SELECT * FROM decks WHERE userId = ? ORDER BY updatedAt DESC", [req.user.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: "Failed to fetch saved decks." });
    const parsedDecks = rows.map(row => ({
      ...row,
      cards: JSON.parse(row.cards)
    }));
    return res.json(parsedDecks);
  });
});

app.post("/api/decks", authenticateToken, (req, res) => {
  const { title, subjectMode, gradeLevel, academicStrand, cards } = req.body;

  if (!cards || !Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: "Deck must contain at least one card." });
  }

  const cardsJson = JSON.stringify(cards);
  db.run(
    `INSERT INTO decks (userId, title, subjectMode, gradeLevel, academicStrand, cards) VALUES (?, ?, ?, ?, ?, ?)`,
    [req.user.userId, title || "Saved Reviewer Deck", subjectMode || "general", gradeLevel || "Grade 11", academicStrand || "Section 1", cardsJson],
    function(err) {
      if (err) return res.status(500).json({ error: "Failed to save flashcard deck." });
      return res.status(201).json({
        id: this.lastID,
        userId: req.user.userId,
        title: title || "Saved Reviewer Deck",
        subjectMode, gradeLevel, academicStrand, cards
      });
    }
  );
});

app.get("/api/decks/:id", authenticateToken, (req, res) => {
  db.get("SELECT * FROM decks WHERE id = ? AND userId = ?", [req.params.id, req.user.userId], (err, row) => {
    if (err || !row) return res.status(404).json({ error: "Flashcard deck not found." });
    row.cards = JSON.parse(row.cards);
    return res.json(row);
  });
});

app.put("/api/decks/:id", authenticateToken, (req, res) => {
  const { title, cards } = req.body;
  db.get("SELECT * FROM decks WHERE id = ? AND userId = ?", [req.params.id, req.user.userId], (err, deck) => {
    if (err || !deck) return res.status(404).json({ error: "Deck not found or unauthorized." });

    const newTitle = title || deck.title;
    const newCardsJson = cards && Array.isArray(cards) ? JSON.stringify(cards) : deck.cards;

    db.run(
      "UPDATE decks SET title = ?, cards = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND userId = ?",
      [newTitle, newCardsJson, req.params.id, req.user.userId],
      (updateErr) => {
        if (updateErr) return res.status(500).json({ error: "Failed to update flashcard deck." });
        return res.json({ message: "Deck updated successfully", title: newTitle, cards: JSON.parse(newCardsJson) });
      }
    );
  });
});

app.delete("/api/decks/:id", authenticateToken, (req, res) => {
  db.run("DELETE FROM decks WHERE id = ? AND userId = ?", [req.params.id, req.user.userId], function(err) {
    if (err || this.changes === 0) return res.status(404).json({ error: "Deck not found or unauthorized." });
    return res.json({ message: "Flashcard deck deleted successfully." });
  });
});

// --- WILDCARD CATCH-ALL ROUTE ---
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// --- GLOBAL ERROR HANDLERS ---
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Request body must contain valid JSON." });
  }

  console.error("Global Server Error:", err.stack);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

process.on("unhandledRejection", (reason) => {
  console.error("Caught unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Caught uncaught exception:", error);
});

// --- SERVER LISTEN ---
app.listen(PORT, () => {
  console.log(`===========================================`);
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`===========================================`);
});