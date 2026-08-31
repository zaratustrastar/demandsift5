import type {
  DashboardMetrics,
  LockedResultCounts,
  LockedStoredResult,
  NavigationSection,
  RedditDemandDemoData,
  RedditOpportunity,
} from "./types";

const lockedResults: LockedStoredResult[] = [
  {
    id: "locked-opportunity-01",
    kind: "opportunity",
    headline: "A founder asks how to stop shared-inbox requests from going unowned",
    sourceLabel: "r/FounderWorkflow · mock post",
    capturedAt: "2026-08-05T08:42:00.000Z",
    provider: "mock-reddit-provider",
    isMock: true,
    buyerIntent: "high",
    hasSuggestedReply: true,
  },
  {
    id: "locked-opportunity-02",
    kind: "opportunity",
    headline: "A support lead compares lightweight tools for weekly queue reviews",
    sourceLabel: "r/SupportSystems · mock comment",
    capturedAt: "2026-08-05T07:31:00.000Z",
    provider: "mock-reddit-provider",
    isMock: true,
    buyerIntent: "medium",
    hasSuggestedReply: true,
  },
  {
    id: "locked-opportunity-03",
    kind: "opportunity",
    headline: "A small team wants reminders without enterprise help-desk complexity",
    sourceLabel: "r/TinyTeams · mock post",
    capturedAt: "2026-08-04T18:14:00.000Z",
    provider: "mock-reddit-provider",
    isMock: true,
    buyerIntent: "high",
    hasSuggestedReply: true,
  },
  {
    id: "locked-opportunity-04",
    kind: "opportunity",
    headline: "An operator describes the cost of answering the same request twice",
    sourceLabel: "r/OperationsCraft · mock comment",
    capturedAt: "2026-08-04T16:09:00.000Z",
    provider: "mock-reddit-provider",
    isMock: true,
    buyerIntent: "low",
    hasSuggestedReply: false,
  },
  {
    id: "locked-opportunity-05",
    kind: "opportunity",
    headline: "A buyer asks for a clean way to assign customer conversations",
    sourceLabel: "r/B2BSaaSTalk · mock post",
    capturedAt: "2026-08-04T13:27:00.000Z",
    provider: "mock-reddit-provider",
    isMock: true,
    buyerIntent: "high",
    hasSuggestedReply: true,
  },
  {
    id: "locked-opportunity-06",
    kind: "opportunity",
    headline: "A customer-success manager asks about visibility across handoffs",
    sourceLabel: "r/CustomerTeams · mock post",
    capturedAt: "2026-08-03T20:05:00.000Z",
    provider: "mock-reddit-provider",
    isMock: true,
    buyerIntent: "medium",
    hasSuggestedReply: false,
  },
  {
    id: "locked-opportunity-07",
    kind: "opportunity",
    headline: "A founder looks for a shared inbox their team will actually maintain",
    sourceLabel: "r/CalmCompany · mock comment",
    capturedAt: "2026-08-03T11:18:00.000Z",
    provider: "mock-reddit-provider",
    isMock: true,
    buyerIntent: "medium",
    hasSuggestedReply: false,
  },
  {
    id: "locked-insight-01",
    kind: "insight",
    headline: "Small teams value clear ownership more than complex automation",
    sourceLabel: "3 stored mock conversations",
    capturedAt: "2026-08-05T09:02:00.000Z",
    provider: "demo-analysis-provider",
    isMock: true,
  },
  {
    id: "locked-insight-02",
    kind: "insight",
    headline: "Reminder language performs better when framed around customer trust",
    sourceLabel: "2 stored mock conversations",
    capturedAt: "2026-08-05T09:02:00.000Z",
    provider: "demo-analysis-provider",
    isMock: true,
  },
  {
    id: "locked-insight-03",
    kind: "insight",
    headline: "Buyers ask for process guidance before asking for a product",
    sourceLabel: "4 stored mock conversations",
    capturedAt: "2026-08-05T09:02:00.000Z",
    provider: "demo-analysis-provider",
    isMock: true,
  },
  {
    id: "locked-competitor-01",
    kind: "competitor",
    headline: "QueuePilot setup language creates uncertainty for small teams",
    sourceLabel: "2 stored mock conversations",
    capturedAt: "2026-08-05T09:03:00.000Z",
    provider: "demo-analysis-provider",
    isMock: true,
  },
  {
    id: "locked-competitor-02",
    kind: "competitor",
    headline: "Buyers describe role configuration as heavier than expected",
    sourceLabel: "1 stored mock conversation",
    capturedAt: "2026-08-05T09:03:00.000Z",
    provider: "demo-analysis-provider",
    isMock: true,
  },
  {
    id: "locked-visibility-01",
    kind: "visibility",
    headline: "Answer the exact question: how should a small SaaS team assign support ownership?",
    sourceLabel: "Website-and-demand content gap",
    capturedAt: "2026-08-05T09:04:00.000Z",
    provider: "demo-analysis-provider",
    isMock: true,
  },
  {
    id: "locked-visibility-02",
    kind: "visibility",
    headline: "Publish a practical shared-inbox handoff checklist",
    sourceLabel: "Website-and-demand content gap",
    capturedAt: "2026-08-05T09:04:00.000Z",
    provider: "demo-analysis-provider",
    isMock: true,
  },
];

export function countLockedResults(
  results: LockedStoredResult[],
): LockedResultCounts {
  return results.reduce<LockedResultCounts>(
    (counts, result) => {
      if (result.kind === "opportunity") counts.opportunities += 1;
      if (result.kind === "insight") counts.insights += 1;
      if (result.kind === "competitor") counts.competitorSignals += 1;
      if (result.kind === "visibility") counts.visibilityOpportunities += 1;
      if (result.hasSuggestedReply) counts.readyReplies += 1;
      return counts;
    },
    {
      opportunities: 0,
      insights: 0,
      competitorSignals: 0,
      visibilityOpportunities: 0,
      readyReplies: 0,
    },
  );
}

function buildMetrics(
  opportunities: RedditOpportunity[],
  locked: LockedStoredResult[],
): DashboardMetrics {
  const lockedOpportunityRecords = locked.filter(
    (result) => result.kind === "opportunity",
  );

  return {
    qualifiedOpportunities:
      opportunities.length + lockedOpportunityRecords.length,
    highIntentOpportunities:
      opportunities.filter(
        (opportunity) => opportunity.classification.buyerIntent === "high",
      ).length +
      lockedOpportunityRecords.filter((result) => result.buyerIntent === "high")
        .length,
    readyReplies:
      opportunities.filter((opportunity) => Boolean(opportunity.reply)).length +
      lockedOpportunityRecords.filter((result) => result.hasSuggestedReply).length,
    competitorSignals:
      opportunities.filter(
        (opportunity) => opportunity.classification.competitorComplaint,
      ).length + locked.filter((result) => result.kind === "competitor").length,
    publishedReplies: 0,
    trackedClicks: 0,
    trackedConversions: 0,
  };
}

const opportunities: RedditOpportunity[] = [
  {
    id: "opportunity-handoff-ownership",
    provider: "mock-reddit-provider",
    isMock: true,
    conversationType: "post",
    subreddit: "r/SaaSBuilders",
    authorLabel: "demo_user_114",
    title: "How do you keep handoffs from disappearing in a shared support inbox?",
    excerpt:
      "We are six people and all dip into the same support inbox. The hard part is not replying—it is knowing who owns the next step after someone says they will look into it. Has anyone found a lightweight process that does not turn into another project-management system?",
    capturedAt: "2026-08-05T08:54:00.000Z",
    permalink: null,
    matchReasons: [
      "Directly describes a problem on the demo website",
      "Actively requests a lightweight solution",
      "Strong fit with the stated small-team audience",
    ],
    classification: {
      relevanceScore: 96,
      buyerIntent: "high",
      customerProblem: "Support handoffs lose clear ownership",
      competitorComplaint: false,
      recommendedAction: "Answer with a practical ownership workflow, then disclose the connection",
      communityRisk: "low",
    },
    reply: {
      id: "reply-handoff-ownership",
      opportunityId: "opportunity-handoff-ownership",
      status: "draft",
      draft:
        "The simplest version is to give every conversation one named owner and make the handoff explicit: the current owner stays responsible until the next person accepts it. A short daily view of unowned and waiting threads catches most gaps without adding a separate project board.\n\nI’m connected to Relaywise, so take this as product-context rather than a neutral recommendation: our fictional demo product is built around named thread ownership, internal handoff notes and reminders for waiting conversations. Even if you use another tool, I’d test that workflow manually for a week first—the process matters more than the software.",
      alternateDrafts: [
        "Start with one rule: a thread cannot be handed off until the next owner has accepted it. Pair that with two saved views—unowned conversations and conversations waiting past your agreed follow-up time. That usually gives a six-person team enough structure without creating another project board.\n\nDisclosure: I’m connected to Relaywise. The fictional demo product supports named ownership, handoff notes and waiting-conversation reminders, but the same process can be tested in your current inbox first.",
        "You probably do not need a full project-management layer. Assign one accountable owner per thread, record the next action in an internal note and review anything unowned or waiting once a day. The key is keeping responsibility with the current owner until the handoff is accepted.\n\nI work with Relaywise, a fictional demo business in this interface. Its verified demo-site features include thread ownership, internal notes and reminders, which is why the question is relevant—but the workflow itself is tool-agnostic.",
      ],
      disclosure: "I’m connected to Relaywise, so take this as product-context rather than a neutral recommendation.",
      verifiedClaims: [
        "Relaywise supports named ownership for customer conversations.",
        "Relaywise includes internal handoff notes.",
        "Relaywise can remind teams about waiting conversations.",
      ],
      sourceFactIds: [
        "fact-named-ownership",
        "fact-handoff-notes",
        "fact-follow-up-reminders",
      ],
      provenanceIds: [
        "source-demo-features",
        "source-demo-workflow",
        "source-reddit-handoff",
      ],
    },
    provenanceIds: ["source-reddit-handoff", "source-demo-problems"],
  },
  {
    id: "opportunity-sla-reminders",
    provider: "mock-reddit-provider",
    isMock: true,
    conversationType: "post",
    subreddit: "r/CustomerSuccessLab",
    authorLabel: "demo_user_208",
    title: "Lightweight way to set follow-up reminders without a full enterprise help desk?",
    excerpt:
      "Our customer-success team needs a nudge when a conversation has been waiting too long, but most tools we have tried bring a lot of configuration we do not need. We mostly want shared visibility, an owner and a sensible reminder. What are small teams using?",
    capturedAt: "2026-08-05T07:48:00.000Z",
    permalink: null,
    matchReasons: [
      "Explicit solution request",
      "Names three capabilities present in the demo website snapshot",
      "Audience and team-size language match",
    ],
    classification: {
      relevanceScore: 93,
      buyerIntent: "high",
      customerProblem: "Follow-ups are missed without a lightweight reminder workflow",
      competitorComplaint: false,
      recommendedAction: "Share a small-team evaluation checklist and mention only verified capabilities",
      communityRisk: "low",
    },
    reply: {
      id: "reply-sla-reminders",
      opportunityId: "opportunity-sla-reminders",
      status: "draft",
      draft:
        "For a small team, I would evaluate this as a three-part workflow rather than an SLA system: one clear owner, a visible ‘waiting’ state and a reminder that fires after your chosen follow-up window. If a tool needs a long implementation before it can do those three things, it is probably heavier than your use case.\n\nDisclosure: I’m connected to Relaywise. In this fictional demo, its website verifies shared conversation ownership, waiting views and follow-up reminders. I would still compare it against your current inbox process and choose the least complex option that makes missed follow-ups visible.",
      alternateDrafts: [
        "You can keep this lightweight by defining one follow-up window, assigning one owner and reviewing a single waiting-conversations view. I’d test any product on how quickly the team can answer: who owns this, what is the next action and when should we follow up?\n\nI’m connected to Relaywise, a fictional demo business. Its demo site documents ownership, waiting views and configurable reminders, so it fits that shortlist; I have not used it as a customer and cannot speak to experience beyond those verified pages.",
      ],
      disclosure: "I’m connected to Relaywise, a fictional demo business.",
      verifiedClaims: [
        "Relaywise offers shared conversation ownership.",
        "Relaywise provides a view for waiting conversations.",
        "Relaywise supports configurable follow-up reminders.",
      ],
      sourceFactIds: [
        "fact-named-ownership",
        "fact-waiting-view",
        "fact-follow-up-reminders",
      ],
      provenanceIds: [
        "source-demo-features",
        "source-demo-workflow",
        "source-reddit-reminders",
      ],
    },
    provenanceIds: ["source-reddit-reminders", "source-demo-features"],
  },
  {
    id: "opportunity-queuepilot-complaint",
    provider: "mock-reddit-provider",
    isMock: true,
    conversationType: "comment",
    subreddit: "r/BootstrappedOps",
    authorLabel: "demo_user_307",
    title: "Anyone moving away from QueuePilot after confusing ownership setup?",
    excerpt:
      "QueuePilot looked promising, but our tiny team keeps getting stuck on roles and routing rules. We just want an obvious owner, an internal note when context changes hands and a list of conversations that need attention. Is there a calmer alternative?",
    capturedAt: "2026-08-04T19:26:00.000Z",
    permalink: null,
    matchReasons: [
      "Complains about a named fictional demo competitor",
      "Requests an alternative with verified demo-site capabilities",
      "High semantic match to the business problem profile",
    ],
    classification: {
      relevanceScore: 89,
      buyerIntent: "medium",
      customerProblem: "Ownership configuration feels too complex for a small team",
      competitorComplaint: true,
      recommendedAction: "Acknowledge the frustration and offer a tool-agnostic migration checklist",
      communityRisk: "medium",
    },
    reply: {
      id: "reply-queuepilot-complaint",
      opportunityId: "opportunity-queuepilot-complaint",
      status: "draft",
      draft:
        "A calmer setup usually starts with fewer routing rules: assign a default owner manually, add one internal handoff note and keep a single view for unowned or waiting conversations. Before switching, I’d export a small sample of threads and test whether the team can understand ownership without training or custom configuration.\n\nFor transparency, I’m connected to Relaywise, which is a fictional business used in this demo. Its demo website documents named ownership, internal notes and attention views. I can’t validate the QueuePilot experience beyond this mock conversation, but those three checks should make any alternative easier to compare.",
      alternateDrafts: [
        "I’d turn this into a short migration test: import a handful of real threads, ask two teammates to identify the owner and next action without help, then check whether unowned and waiting work is obvious. That will expose complexity faster than a feature checklist.\n\nDisclosure: I’m connected to Relaywise, a fictional demo business whose demo-site pages verify named ownership, handoff notes and attention views. I cannot make claims about QueuePilot outside the mock scenario shown here.",
      ],
      disclosure: "I’m connected to Relaywise, which is a fictional business used in this demo.",
      verifiedClaims: [
        "Relaywise documents named ownership.",
        "Relaywise documents internal handoff notes.",
        "Relaywise documents attention views.",
      ],
      sourceFactIds: [
        "fact-named-ownership",
        "fact-handoff-notes",
        "fact-attention-view",
      ],
      provenanceIds: [
        "source-demo-features",
        "source-reddit-queuepilot",
      ],
    },
    provenanceIds: [
      "source-reddit-queuepilot",
      "source-demo-competitors",
      "source-demo-features",
    ],
  },
];

const lockedCounts = countLockedResults(lockedResults);

const baseNavigation: NavigationSection[] = [
  { id: "dashboard", label: "Overview" },
  {
    id: "opportunities",
    label: "Opportunities",
    badge: opportunities.length + lockedCounts.opportunities,
  },
  {
    id: "insights",
    label: "Insights",
    badge: 2 + lockedCounts.insights,
  },
  {
    id: "competitors",
    label: "Competitors",
    badge: 1 + lockedCounts.competitorSignals,
  },
  {
    id: "visibility",
    label: "AI Visibility",
    shortLabel: "AI Visibility",
    badge: 2 + lockedCounts.visibilityOpportunities,
  },
  {
    id: "replies",
    label: "Replies",
    badge: opportunities.length + lockedCounts.readyReplies,
  },
  { id: "results", label: "Results" },
  { id: "monitoring", label: "Monitoring config" },
  { id: "settings", label: "Settings" },
  { id: "billing", label: "Billing" },
];

export const redditDemandDemoData: RedditDemandDemoData = {
  fixtureLabel: "Mock provider demo",
  fixtureDisclosure:
    "Relaywise, QueuePilot and every Reddit conversation shown here are fictional demo fixtures. No live Reddit post, customer, traffic figure or ranking is represented.",
  generatedAt: "2026-08-05T09:05:00.000Z",
  business: {
    name: "Relaywise",
    url: "https://relaywise.example",
    hostname: "relaywise.example",
    isFictionalDemoBusiness: true,
    oneLineSummary:
      "A fictional shared-inbox workspace that helps small SaaS teams assign, hand off and follow up on customer conversations.",
    productCategory: "Shared inbox and customer-conversation workflow",
    targetAudience: [
      "Small B2B SaaS support teams",
      "Customer-success leads",
      "Founder-led teams sharing one support inbox",
    ],
    problemsSolved: [
      "Customer conversations lose a clear owner",
      "Context disappears during team handoffs",
      "Waiting conversations miss timely follow-up",
    ],
    features: [
      "Named conversation ownership",
      "Internal handoff notes",
      "Unowned and waiting conversation views",
      "Configurable follow-up reminders",
    ],
    competitors: ["QueuePilot (fictional demo competitor)"],
    irrelevantTopics: [
      "Consumer parcel tracking",
      "Call-center workforce scheduling",
      "Enterprise ticketing procurement",
      "Personal email clients",
    ],
    facts: [
      {
        id: "fact-product-summary",
        label: "Product",
        value: "Shared-inbox workflow for small SaaS teams",
        provenanceIds: ["source-demo-home"],
      },
      {
        id: "fact-audience",
        label: "Best fit",
        value: "Small support and customer-success teams",
        provenanceIds: ["source-demo-home", "source-demo-workflow"],
      },
      {
        id: "fact-named-ownership",
        label: "Verified demo capability",
        value: "Named conversation ownership",
        provenanceIds: ["source-demo-features"],
      },
      {
        id: "fact-handoff-notes",
        label: "Verified demo capability",
        value: "Internal handoff notes",
        provenanceIds: ["source-demo-features"],
      },
      {
        id: "fact-follow-up-reminders",
        label: "Verified demo capability",
        value: "Configurable follow-up reminders",
        provenanceIds: ["source-demo-features", "source-demo-workflow"],
      },
      {
        id: "fact-waiting-view",
        label: "Verified demo capability",
        value: "Waiting conversation view",
        provenanceIds: ["source-demo-workflow"],
      },
      {
        id: "fact-attention-view",
        label: "Verified demo capability",
        value: "Unowned and waiting attention views",
        provenanceIds: ["source-demo-workflow"],
      },
    ],
    analyzedPageCount: 3,
    analyzedAt: "2026-08-05T08:39:00.000Z",
  },
  provenance: [
    {
      id: "source-demo-home",
      kind: "website-page",
      title: "Relaywise demo homepage fixture",
      provider: "demo-website-snapshot",
      url: "https://relaywise.example/",
      retrievedAt: "2026-08-05T08:37:00.000Z",
      excerpt:
        "Give every customer conversation a clear owner without adding a heavyweight help desk.",
      isMock: true,
      verifiedWithinDemoFixture: true,
    },
    {
      id: "source-demo-features",
      kind: "website-page",
      title: "Relaywise demo features fixture",
      provider: "demo-website-snapshot",
      url: "https://relaywise.example/features",
      retrievedAt: "2026-08-05T08:38:00.000Z",
      excerpt:
        "Assign an owner, leave internal handoff notes and keep the next step visible.",
      isMock: true,
      verifiedWithinDemoFixture: true,
    },
    {
      id: "source-demo-workflow",
      kind: "website-page",
      title: "Relaywise demo workflow fixture",
      provider: "demo-website-snapshot",
      url: "https://relaywise.example/workflow",
      retrievedAt: "2026-08-05T08:38:30.000Z",
      excerpt:
        "Review unowned and waiting conversations, then set a follow-up reminder that matches your team’s process.",
      isMock: true,
      verifiedWithinDemoFixture: true,
    },
    {
      id: "source-demo-problems",
      kind: "derived-analysis",
      title: "Problems derived from three demo website pages",
      provider: "demo-analysis-provider",
      url: null,
      retrievedAt: "2026-08-05T08:39:00.000Z",
      excerpt:
        "Clear ownership, retained handoff context and timely follow-up are the repeated product promises.",
      isMock: true,
      verifiedWithinDemoFixture: true,
    },
    {
      id: "source-demo-competitors",
      kind: "derived-analysis",
      title: "Fictional competitor set for the demo fixture",
      provider: "demo-analysis-provider",
      url: null,
      retrievedAt: "2026-08-05T08:40:00.000Z",
      excerpt:
        "QueuePilot is an explicitly fictional comparison product used only by this mock dataset.",
      isMock: true,
      verifiedWithinDemoFixture: true,
    },
    {
      id: "source-reddit-handoff",
      kind: "reddit-conversation",
      title: "Mock conversation: shared-inbox handoffs",
      provider: "mock-reddit-provider",
      url: null,
      retrievedAt: "2026-08-05T08:54:00.000Z",
      excerpt:
        "The hard part is knowing who owns the next step after someone says they will look into it.",
      isMock: true,
      verifiedWithinDemoFixture: true,
    },
    {
      id: "source-reddit-reminders",
      kind: "reddit-conversation",
      title: "Mock conversation: lightweight follow-up reminders",
      provider: "mock-reddit-provider",
      url: null,
      retrievedAt: "2026-08-05T07:48:00.000Z",
      excerpt:
        "We mostly want shared visibility, an owner and a sensible reminder.",
      isMock: true,
      verifiedWithinDemoFixture: true,
    },
    {
      id: "source-reddit-queuepilot",
      kind: "reddit-conversation",
      title: "Mock conversation: QueuePilot complexity complaint",
      provider: "mock-reddit-provider",
      url: null,
      retrievedAt: "2026-08-04T19:26:00.000Z",
      excerpt:
        "We just want an obvious owner, an internal note and a list of conversations that need attention.",
      isMock: true,
      verifiedWithinDemoFixture: true,
    },
  ],
  // Demo fixture: themes are aggregated from the fictional corpus above, so the
  // evidence links resolve to the same fictional conversations.
  conversationThemes: [],
  insights: [
    {
      id: "insight-ownership-before-automation",
      eyebrow: "Customer demand insight",
      title: "Small teams want visible ownership before they want automation",
      summary:
        "The strongest mock conversations are not asking for more routing logic. They ask for one accountable person, a visible next step and fewer places to check.",
      evidence: [
        {
          quote: "The hard part is … knowing who owns the next step.",
          sourceLabel: "r/SaaSBuilders · mock post",
          provenanceId: "source-reddit-handoff",
        },
        {
          quote: "We mostly want shared visibility, an owner and a sensible reminder.",
          sourceLabel: "r/CustomerSuccessLab · mock post",
          provenanceId: "source-reddit-reminders",
        },
      ],
      whyItMatters:
        "Lead with the operational outcome—clear accountability—before describing workflow features.",
      recommendedAction:
        "Publish a one-page ownership workflow and use it as the useful resource in relevant replies.",
      signalStrength: "high",
      opportunityIds: [
        "opportunity-handoff-ownership",
        "opportunity-sla-reminders",
      ],
      provenanceIds: ["source-reddit-handoff", "source-reddit-reminders"],
    },
    {
      id: "insight-lightweight-buying-language",
      eyebrow: "Buyer-language insight",
      title: "“Lightweight” means fast to understand, not merely fewer features",
      summary:
        "Mock buyers repeatedly describe the desired product in workflow terms: obvious ownership, one attention view and reminders that require little configuration.",
      evidence: [
        {
          quote: "A lightweight process that does not turn into another project-management system.",
          sourceLabel: "r/SaaSBuilders · mock post",
          provenanceId: "source-reddit-handoff",
        },
        {
          quote: "Most tools … bring a lot of configuration we do not need.",
          sourceLabel: "r/CustomerSuccessLab · mock post",
          provenanceId: "source-reddit-reminders",
        },
      ],
      whyItMatters:
        "Feature-count claims will be less persuasive than showing how quickly a team can see ownership and next steps.",
      recommendedAction:
        "Frame the demo and onboarding around a five-minute ownership check rather than a broad feature tour.",
      signalStrength: "high",
      opportunityIds: [
        "opportunity-handoff-ownership",
        "opportunity-sla-reminders",
      ],
      provenanceIds: ["source-reddit-handoff", "source-reddit-reminders"],
    },
  ],
  competitorWeaknesses: [
    {
      id: "competitor-gap-queuepilot-complexity",
      verified: true,
      competitorName: "QueuePilot",
      competitorIsFictionalDemo: true,
      headline: "Configuration complexity leaves an opening for a calmer first-run experience",
      summary:
        "One qualified mock conversation says role and routing setup obscures the simple outcome the buyer wants. This is a directional signal, not evidence of broad competitor sentiment.",
      evidence: [
        {
          quote: "Our tiny team keeps getting stuck on roles and routing rules.",
          sourceLabel: "r/BootstrappedOps · mock comment",
          provenanceId: "source-reddit-queuepilot",
        },
      ],
      recommendedAction:
        "Demonstrate ownership, handoff notes and the attention view before exposing configuration choices.",
      signalStrength: "medium",
      opportunityIds: ["opportunity-queuepilot-complaint"],
      provenanceIds: ["source-reddit-queuepilot", "source-demo-competitors"],
    },
  ],
  opportunities,
  lockedResults,
  lockedCounts,
  metrics: buildMetrics(opportunities, lockedResults),
  navigation: baseNavigation,
  analysisProgress: [
    {
      id: "validate-url",
      label: "Checking your website",
      detail: "Validating the URL and same-domain crawl boundaries",
    },
    {
      id: "read-pages",
      label: "Understanding the business",
      detail: "Reading public same-domain pages and retaining source provenance",
    },
    {
      id: "build-profile",
      label: "Building the demand profile",
      detail: "Extracting audience, problems, capabilities and irrelevant topics",
    },
    {
      id: "find-conversations",
      label: "Finding useful conversations",
      detail: "Querying the approved provider and removing duplicates and noise",
    },
    {
      id: "rank-opportunities",
      label: "Ranking the best opportunities",
      detail: "Scoring fit, buyer intent, customer problems and community risk",
    },
    {
      id: "draft-replies",
      label: "Preparing thoughtful replies",
      detail: "Grounding each draft in the conversation and verified website facts",
    },
  ],
  visibilityOpportunities: [
    {
      id: "visibility-ownership-guide",
      title: "Create the clearest answer to the ownership-workflow question",
      summary:
        "The demo website states the outcome, but it does not yet provide a standalone guide that answers how a small team should assign and hand off customer conversations.",
      recommendedAction:
        "Publish a concise, example-led guide and link to it only when it genuinely answers a conversation.",
      verificationNote:
        "Content-gap observation only. No traffic, ranking or AI-citation claim is made because no external visibility provider is connected.",
      provenanceIds: [
        "source-demo-home",
        "source-demo-workflow",
        "source-reddit-handoff",
      ],
    },
    {
      id: "visibility-reminder-checklist",
      title: "Turn follow-up-reminder demand into a practical checklist",
      summary:
        "The mock demand language is specific enough to support a useful evaluation checklist covering ownership, waiting state and reminder timing.",
      recommendedAction:
        "Add a checklist page grounded in verified product behavior and avoid unverified performance claims.",
      verificationNote:
        "Search & AI Visibility Opportunity only; search volume and rankings have not been measured.",
      provenanceIds: [
        "source-demo-features",
        "source-reddit-reminders",
      ],
    },
  ],
  pricing: [
    {
      id: "market-scan",
      name: "Personalized Market Scan",
      priceInCents: 0,
      cadence: "free",
      description: "A focused preview of the strongest stored findings.",
      features: [
        "Concise business profile",
        "Two complete demand insights",
        "One competitor weakness",
        "Three complete opportunities",
        "One complete suggested reply",
      ],
      checkoutNote: "No card required.",
      requiresVerifiedWebhook: false,
    },
    {
      id: "full-access-pass",
      name: "Full Access Pass",
      priceInCents: 1200,
      cadence: "one-time",
      durationDays: 7,
      description:
        "Unlock every existing finding, suggested reply and seven days of monitoring.",
      features: [
        "All stored opportunities and insights",
        "All suggested replies",
        "Competitor intelligence",
        "Seven days of monitoring",
      ],
      checkoutNote:
        "$12 one-time, excluding VAT where applicable. Tax is calculated at checkout; processing fees are not added as a separate charge.",
      requiresVerifiedWebhook: true,
    },
    {
      id: "core",
      name: "Core",
      priceInCents: 3000,
      cadence: "monthly",
      description:
        "Continuous demand intelligence and basic outcome tracking for one business.",
      features: [
        "Continuous monitoring",
        "All opportunities and demand insights",
        "Competitor intelligence and summaries",
        "Suggested replies",
        "Basic click and conversion tracking",
      ],
      checkoutNote:
        "$30/month, excluding VAT where applicable. Starts only after an explicit purchase and a verified Stripe webhook.",
      requiresVerifiedWebhook: true,
    },
  ],
};

export const demoBusinessProfile = redditDemandDemoData.business;
export const demoDemandInsights = redditDemandDemoData.insights;
export const demoCompetitorWeakness =
  redditDemandDemoData.competitorWeaknesses[0];
export const demoRedditOpportunities = redditDemandDemoData.opportunities;
export const demoLockedResults = redditDemandDemoData.lockedResults;
export const demoDashboardMetrics = redditDemandDemoData.metrics;
export const demoNavigationSections = redditDemandDemoData.navigation;
