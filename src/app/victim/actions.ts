"use server";

import { headers } from "next/headers";
import { ticketBudget, visitorKey } from "@/lib/victim/limits";
import { fileTicket } from "@/lib/victim/tickets";

export type CreateTicketState = { id?: string; error?: string };

export async function createTicket(_prev: CreateTicketState, formData: FormData): Promise<CreateTicketState> {
  const field = (name: string, max: number) => {
    const v = formData.get(name);
    const s = typeof v === "string" ? v.trim() : "";
    return s && s.length <= max ? s : null;
  };
  const customer_email = field("email", 200);
  const subject = field("subject", 200);
  const body = field("body", 10000);

  if (!customer_email || !/^\S+@\S+\.\S+$/.test(customer_email)) return { error: "Enter a valid email." };
  if (!subject) return { error: "Subject is required (max 200 characters)." };
  if (!body) return { error: "Message is required (max 10,000 characters)." };

  // The form is public: each visitor has a budget of tickets, under a ceiling for the whole site.
  if (!ticketBudget.take(visitorKey(await headers()))) return { error: "Too many requests right now. Try again in a minute." };

  try {
    return { id: await fileTicket(customer_email, subject, body) };
  } catch {
    return { error: "The request could not be saved. Try again." };
  }
}
