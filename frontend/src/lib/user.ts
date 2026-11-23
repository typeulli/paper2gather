"use client";

import { useSyncExternalStore } from "react";

export interface LocalUser {
  name: string;
  color: string;
}

export const USER_COLORS = [
  "#e11d48",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0d9488",
  "#0284c7",
  "#4f46e5",
  "#9333ea",
  "#c026d3",
  "#64748b",
];

const STORAGE_KEY = "paper2gather:user";
const listeners = new Set<() => void>();
let cached: LocalUser | null = null;

function randomUser(): LocalUser {
  const n = Math.floor(Math.random() * 900) + 100;
  return {
    name: `Guest ${n}`,
    color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  };
}

function read(): LocalUser {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LocalUser;
      if (parsed?.name && parsed?.color) return (cached = parsed);
    }
  } catch {
    // ignore corrupted storage
  }
  cached = randomUser();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // storage may be unavailable (private mode)
  }
  return cached;
}

export function setLocalUser(user: LocalUser): void {
  cached = user;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    // storage may be unavailable (private mode)
  }
  listeners.forEach((l) => l());
}

const SERVER_USER: LocalUser = { name: "", color: USER_COLORS[0] };

export function useLocalUser(): LocalUser {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => SERVER_USER
  );
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
