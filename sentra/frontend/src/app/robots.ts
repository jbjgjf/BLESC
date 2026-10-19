import type { MetadataRoute } from "next";
import { robotsPolicy } from "@/lib/robotsPolicy";

// `NEXT_PUBLIC_PILOT_MODE` is inlined at build time, the same as in
// `next.config.ts`, so a cached robots.txt is the right one for this build.
export default function robots(): MetadataRoute.Robots {
  return robotsPolicy(process.env.NEXT_PUBLIC_PILOT_MODE === "1");
}
