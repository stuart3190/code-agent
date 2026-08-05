import { auth } from "../lib/backend";

function randomToken() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeVisitorCredentials() {
  const token = randomToken();
  return {
    email: `visitor-${token}@berrybrook.local`,
    password: `BerryBrook-${randomToken()}-${randomToken()}`,
  };
}

export async function currentVisitor() {
  return auth.currentUser();
}

export async function ensureVisitorSession() {
  const existingUser = await auth.currentUser();
  if (existingUser) return existingUser;

  const credentials = makeVisitorCredentials();
  try {
    return await auth.signUp(credentials);
  } catch (error) {
    try {
      return await auth.signIn(credentials);
    } catch {
      throw error;
    }
  }
}
