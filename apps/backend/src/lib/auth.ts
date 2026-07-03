import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

export type AuthTokenPayload = {
  sub: number;
  email: string;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(user: { id: number; email: string }): string {
  const payload: AuthTokenPayload = { sub: user.id, email: user.email };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"] });
}

export function verifyAccessToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  if (!decoded?.sub || !decoded?.email) {
    throw new Error("invalid_token");
  }
  return { sub: Number(decoded.sub), email: String(decoded.email) };
}
