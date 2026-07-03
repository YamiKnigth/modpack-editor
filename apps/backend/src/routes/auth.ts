import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { hashPassword, signAccessToken, verifyPassword } from "../lib/auth.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(8).max(200),
  nombre: z.string().min(2).max(120).optional(),
});

const loginSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(8).max(200),
});

authRouter.post("/register", async (req, res, next) => {
  try {
    const payload = registerSchema.parse(req.body);
    const email = payload.email.trim().toLowerCase();

    const exists = await db.query("SELECT id FROM app_users WHERE email = $1", [email]);
    if (exists.rowCount) {
      res.status(409).json({ error: { code: "CONFLICT", message: "Email already registered" } });
      return;
    }

    const passwordHash = await hashPassword(payload.password);
    const created = await db.query(
      `
      INSERT INTO app_users (email, password_hash, nombre)
      VALUES ($1, $2, $3)
      RETURNING id, email, nombre
      `,
      [email, passwordHash, payload.nombre ?? null],
    );

    const user = created.rows[0];
    const token = signAccessToken({ id: Number(user.id), email: String(user.email) });

    res.status(201).json({ data: { token, user: { id: Number(user.id), email: user.email, nombre: user.nombre } } });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const payload = loginSchema.parse(req.body);
    const email = payload.email.trim().toLowerCase();

    const found = await db.query(
      "SELECT id, email, nombre, password_hash FROM app_users WHERE email = $1 LIMIT 1",
      [email],
    );

    if (!found.rowCount) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid credentials" } });
      return;
    }

    const row = found.rows[0];
    const ok = await verifyPassword(payload.password, String(row.password_hash));
    if (!ok) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid credentials" } });
      return;
    }

    const token = signAccessToken({ id: Number(row.id), email: String(row.email) });
    res.json({ data: { token, user: { id: Number(row.id), email: row.email, nombre: row.nombre ?? null } } });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const userId = Number(req.user?.id);
    const found = await db.query("SELECT id, email, nombre, created_at AS \"createdAt\" FROM app_users WHERE id = $1", [
      userId,
    ]);
    if (!found.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found" } });
      return;
    }
    res.json({ data: found.rows[0] });
  } catch (error) {
    next(error);
  }
});
