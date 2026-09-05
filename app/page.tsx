import type { Metadata } from "next";
import { ThreadlineExperience } from "../components/ThreadlineExperience";

// Landing-page-only copy: the Scooptr rename per design_handoff_scooptr is
// scoped to this route for now (see ThreadlineExperience.tsx's Landing
// component); the app-wide rename listed in that README's prerequisites is
// a separate, not-yet-started piece of work.
export const metadata: Metadata = {
  title: "Scooptr — find the Reddit threads where your next customers already are",
  description:
    "Give us your website. We read it, work out what you sell, and bring back the Reddit threads where someone is asking for it right now — with a reply you'd be happy to post.",
};

export default function Home() {
  return <ThreadlineExperience />;
}
