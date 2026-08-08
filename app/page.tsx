import type { Metadata } from "next";
import { ThreadlineExperience } from "../components/ThreadlineExperience";

export const metadata: Metadata = {
  title: "Threadline — Reddit demand intelligence",
  description:
    "Turn public Reddit conversations into focused, evidence-backed customer opportunities.",
};

export default function Home() {
  return <ThreadlineExperience />;
}
