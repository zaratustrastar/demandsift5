import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { createId } from "@/lib/server/ids";
import {
  normalizedBusinessHostname,
  presentAccess,
  requireOwnedScan,
} from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

type ConversionBody = {
  scanId?: unknown;
  replyId?: unknown;
  kind?: unknown;
  label?: unknown;
  valueCents?: unknown;
};

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "conversion:create", { limit: 120, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const body = await readJson<ConversionBody>(request);
    if (typeof body.scanId !== "string") {
      throw new ApiError("scanId is required.", 400, "scan_id_required");
    }
    const scan = await requireOwnedScan(actor.workspaceId, body.scanId);
    const access = await presentAccess(actor.workspaceId, scan.websiteUrl);
    if (
      access.plan !== "core" ||
      access.status !== "active" ||
      !access.capabilities.resultsTracking
    ) {
      throw new ApiError("Results tracking is included with Core.", 402, "core_required");
    }
    const kind: "click" | "conversion" | null =
      body.kind === "click" || body.kind === "conversion" ? body.kind : null;
    if (!kind) throw new ApiError("kind must be click or conversion.", 400, "invalid_conversion_kind");
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 120) : "";
    if (!label) throw new ApiError("A short label is required.", 400, "label_required");
    const replyId = typeof body.replyId === "string" ? body.replyId : null;
    if (replyId) {
      const reply = await getStateRepository().getReply(replyId);
      if (!reply || reply.workspaceId !== actor.workspaceId || reply.scanId !== body.scanId) {
        throw new ApiError("Reply was not found.", 404, "reply_not_found");
      }
    }
    const valueCents = body.valueCents === undefined || body.valueCents === null ? null : Number(body.valueCents);
    if (valueCents !== null && (!Number.isInteger(valueCents) || valueCents < 0 || valueCents > 100_000_000)) {
      throw new ApiError("valueCents must be a non-negative integer.", 400, "invalid_conversion_value");
    }
    const conversion = {
      id: createId("result"),
      workspaceId: actor.workspaceId,
      scanId: body.scanId,
      replyId,
      kind,
      label,
      valueCents,
      createdAt: new Date().toISOString(),
    };
    await getStateRepository().saveConversion(conversion);
    const workspaceResults = await getStateRepository().listConversions(actor.workspaceId);
    return Response.json(
      {
        result: conversion,
        totals: {
          clicks: workspaceResults.filter((row) => row.kind === "click").length,
          conversions: workspaceResults.filter((row) => row.kind === "conversion").length,
          valueCents: workspaceResults.reduce((sum, row) => sum + (row.valueCents ?? 0), 0),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const actor = await requireWorkspace(request);
    const access = await presentAccess(actor.workspaceId);
    if (
      access.plan !== "core" ||
      access.status !== "active" ||
      !access.capabilities.resultsTracking
    ) {
      throw new ApiError("Results tracking is included with Core.", 402, "core_required");
    }
    const repository = getStateRepository();
    const purchasedHostname = normalizedBusinessHostname(access.businessWebsiteUrl);
    const candidates = await repository.listConversions(actor.workspaceId);
    const rows = (
      await Promise.all(candidates.map(async (row) => ({
        row,
        scan: await repository.getScan(row.scanId),
      })))
    )
      .filter(({ scan }) =>
        Boolean(
          scan &&
          purchasedHostname &&
          normalizedBusinessHostname(scan.websiteUrl) === purchasedHostname,
        ))
      .map(({ row }) => row);
    return Response.json({
      results: rows,
      totals: {
        clicks: rows.filter((row) => row.kind === "click").length,
        conversions: rows.filter((row) => row.kind === "conversion").length,
        valueCents: rows.reduce((sum, row) => sum + (row.valueCents ?? 0), 0),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
