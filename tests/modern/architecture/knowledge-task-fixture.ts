// Task-specific instructions supplied by the governed activity profile, not guest role dispatch.
export const architectureTaskInstructions = (sourceCommit: string) => [
	'Return model exactly "knowledge".',
	'Return bookRef equal to the exact authorized Architecture Book reference.',
	'A negative claim about what is absent from serialized request bytes needs evidence from the actual serializer or request-construction path.',
	'Copy every related reference ID, commit, and digest exactly from the authorized context.',
	`The exact attached project Git source commit is ${sourceCommit}.`,
	`FINAL SOURCE AUDIT: In contentOutput.body, every phrase claiming an SDK or project Git source commit must use exactly ${sourceCommit}.`,
	'Return verification: []: source inspection belongs in the page body.',
];
