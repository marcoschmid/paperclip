import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, documentRevisions, projectDocuments } from "@paperclipai/db";

export interface UpsertProjectDocumentInput {
  projectId: string;
  key: string;
  body: string;
  title?: string | null;
  format?: string;
  changeSummary?: string | null;
  tags?: unknown;
  metadata?: Record<string, unknown>;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  createdByRunId?: string | null;
}

// Phase-6 project-memory: a project + key (e.g. "project-memory") maps to a
// backing document. Upsert appends a new revision to the existing document, or
// creates the document + first revision + link on first write — reusing the
// documents/document_revisions machinery so history is preserved.
export function projectDocumentService(db: Db) {
  return {
    upsert: async (companyId: string, input: UpsertProjectDocumentInput) => {
      const format = input.format ?? "markdown";
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(projectDocuments)
          .where(
            and(
              eq(projectDocuments.companyId, companyId),
              eq(projectDocuments.projectId, input.projectId),
              eq(projectDocuments.key, input.key),
            ),
          )
          .limit(1);

        if (existing) {
          const [document] = await tx
            .select()
            .from(documents)
            .where(eq(documents.id, existing.documentId))
            .limit(1);
          const nextRevisionNumber = document.latestRevisionNumber + 1;

          const [revision] = await tx
            .insert(documentRevisions)
            .values({
              companyId,
              documentId: document.id,
              revisionNumber: nextRevisionNumber,
              title: input.title ?? document.title,
              format,
              body: input.body,
              changeSummary: input.changeSummary ?? null,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
              createdByRunId: input.createdByRunId ?? null,
            })
            .returning();

          const [updatedDocument] = await tx
            .update(documents)
            .set({
              title: input.title ?? document.title,
              format,
              latestBody: input.body,
              latestRevisionId: revision.id,
              latestRevisionNumber: nextRevisionNumber,
              ...(input.tags !== undefined ? { tags: input.tags } : {}),
              ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
              updatedByAgentId: input.createdByAgentId ?? null,
              updatedByUserId: input.createdByUserId ?? null,
              updatedAt: new Date(),
            })
            .where(eq(documents.id, document.id))
            .returning();

          await tx
            .update(projectDocuments)
            .set({ updatedAt: new Date() })
            .where(eq(projectDocuments.id, existing.id));

          return { created: false, projectDocument: existing, document: updatedDocument, revision };
        }

        const [document] = await tx
          .insert(documents)
          .values({
            companyId,
            title: input.title ?? null,
            format,
            latestBody: input.body,
            latestRevisionId: null,
            latestRevisionNumber: 1,
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            updatedByAgentId: input.createdByAgentId ?? null,
            updatedByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            companyId,
            documentId: document.id,
            revisionNumber: 1,
            title: input.title ?? null,
            format,
            body: input.body,
            changeSummary: input.changeSummary ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
            createdByRunId: input.createdByRunId ?? null,
          })
          .returning();

        await tx
          .update(documents)
          .set({ latestRevisionId: revision.id })
          .where(eq(documents.id, document.id));

        const [link] = await tx
          .insert(projectDocuments)
          .values({
            companyId,
            projectId: input.projectId,
            documentId: document.id,
            key: input.key,
          })
          .returning();

        return {
          created: true,
          projectDocument: link,
          document: { ...document, latestRevisionId: revision.id },
          revision,
        };
      });
    },

    getByKey: async (companyId: string, projectId: string, key: string) => {
      const [row] = await db
        .select({
          id: projectDocuments.id,
          key: projectDocuments.key,
          projectId: projectDocuments.projectId,
          documentId: projectDocuments.documentId,
          title: documents.title,
          format: documents.format,
          body: documents.latestBody,
          latestRevisionNumber: documents.latestRevisionNumber,
          tags: documents.tags,
          metadata: documents.metadata,
          createdAt: projectDocuments.createdAt,
          updatedAt: projectDocuments.updatedAt,
        })
        .from(projectDocuments)
        .innerJoin(documents, eq(documents.id, projectDocuments.documentId))
        .where(
          and(
            eq(projectDocuments.companyId, companyId),
            eq(projectDocuments.projectId, projectId),
            eq(projectDocuments.key, key),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    list: async (companyId: string, projectId: string) => {
      return db
        .select({
          id: projectDocuments.id,
          key: projectDocuments.key,
          documentId: projectDocuments.documentId,
          title: documents.title,
          format: documents.format,
          latestRevisionNumber: documents.latestRevisionNumber,
          tags: documents.tags,
          updatedAt: projectDocuments.updatedAt,
        })
        .from(projectDocuments)
        .innerJoin(documents, eq(documents.id, projectDocuments.documentId))
        .where(
          and(eq(projectDocuments.companyId, companyId), eq(projectDocuments.projectId, projectId)),
        )
        .orderBy(desc(projectDocuments.updatedAt));
    },
  };
}
