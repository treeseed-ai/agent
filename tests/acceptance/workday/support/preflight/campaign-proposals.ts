import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument, visit } from 'yaml';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { read, row, type Row } from '../../../acceptance-cli.ts';
import type { readPreRunCampaignFreeze } from '../../../freeze-integrity.ts';
import { sdkProposalText } from '../../../campaign.ts';

const fail = 'ACCEPTANCE_CAMPAIGN_PROPOSALS: Complete current governed draft authority required';

/** Expectations come from the unchanged document; returned content cannot define them. */
function projectContract(document: string, name: string) {
 const sections = document.split(/(?=^### \d+\. )/mu).filter(section => section.startsWith('### '));
 const selected = sections.filter(section => section.split('\n')[0]!.split(' — ')[0]!.replace(/^### \d+\. /u, '') === name);
 assert.equal(selected.length, 1, fail); const section = selected[0]!.split('\n## ')[0]!;
 const field = (key: string) => {
  const lines = section.split('\n').filter(line => line.startsWith('- ' + key + ': '));
  assert.equal(lines.length, 1, fail);
  return lines[0]!.slice(key.length + 4).replace(/\*\*/gu, '').trim();
 };
 const graph = document.split('### Fixed work-item graph\n')[1]?.split('\n### ')[0];
 assert.ok(graph, fail);
 const items = graph.split('\n').flatMap(line => {
  const matched = /^\| `([a-z0-9-]+)` \| ([^|]+) \| `(git|treedx)` \| none \| 2 \|$/u.exec(line);
  if (!matched) return [];
  const role = matched[2]!.trim(), objectives = section.split('\n').filter(value => value.startsWith('| ' + role + ' |'));
  assert.equal(objectives.length, 1, fail); const objective = objectives[0]!.split('|')[2]!.trim(); assert.ok(objective, fail);
  return [{ id: matched[1]!, role, workspace: matched[3]!, objective }];
 });
 assert.equal(items.length, 6, fail);
 const source = field('Source').match(/treeseed-ai\/[a-z0-9-]+#\d+/gu); assert.ok(source?.length, fail);
 return { title: field('Title'), request: field('Request'), summary: field('Summary'), items, source };
}

function proposalProvenance(expected: Row, binding: Row, governance: Row): Row {
 const provenance = row(row(governance.metadata).contentProvenance);
 assert.equal(binding.projectId, expected.projectId, fail); assert.equal(governance.id, expected.id, fail);
 assert.equal(governance.projectId, expected.projectId, fail);
 assert.ok(typeof governance.activeVersion === 'number' && Number.isSafeInteger(governance.activeVersion) && governance.activeVersion > 0, fail);
 assert.equal(provenance.repositoryId, binding.repositoryId, fail);
 assert.match(String(provenance.commitSha), /^[a-f0-9]{40}$/u, fail);
 assert.match(String(provenance.digest), /^[a-f0-9]{64}$/u, fail);
 assert.equal(governance.activeContentHash, provenance.digest, fail);
 assert.ok(typeof provenance.contentPath === 'string' && /^proposals\/[^\\\s\0]+\.mdx$/u.test(provenance.contentPath)
  && !provenance.contentPath.split('/').some((part: string) => !part || part === '.' || part === '..'), fail);
 return provenance;
}

/** Original public index and exact library bytes, not an operator-supplied proposal copy. */
export function verifyCampaignProjectProposal(expected: Row, binding: Row, governance: Row, observed: Row, document: string): void {
 const canonical = projectContract(document, String(expected.name)), provenance = proposalProvenance(expected, binding, governance);
 const sdk = expected.name === 'SDK' ? sdkProposalText(document) : undefined;
 assert.equal(observed.ok, true, fail); assert.equal(observed.repoId, binding.repositoryId, fail);
 assert.equal(observed.ref, provenance.commitSha, fail); assert.equal(observed.resolvedRef, provenance.commitSha, fail);
 assert.ok(Array.isArray(observed.files) && observed.files.length === 1, fail);
 const file = row(observed.files[0]); assert.equal(file.path, provenance.contentPath, fail);
 assert.ok(typeof file.content === 'string' && Buffer.byteLength(file.content) > 0 && Buffer.byteLength(file.content) <= 1_048_576, fail);
 assert.equal(createHash('sha256').update(file.content).digest('hex'), provenance.digest, fail);
 const matched = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u); assert.ok(matched, fail);
 const syntax = parseDocument(matched[1]!, { uniqueKeys: true }); assert.equal(syntax.errors.length, 0, fail);
 visit(syntax, (_key, node) => { if (node && typeof node === 'object' && 'anchor' in node) assert.ok(!node.anchor, fail); });
 const proposal = row(syntax.toJS({ maxAliasCount: 0 })); assert.deepEqual(proposal, file.frontmatter, fail);
 const validated = validatePortableContentData('proposal', proposal);
 assert.equal(validated.ok, true, fail); assert.deepEqual(validated.data, proposal, fail);
 assert.equal(proposal.id, expected.id, fail); assert.equal(proposal.projectId, expected.projectId, fail);
 assert.equal(proposal.status, 'draft', fail);
 for (const [key, indexKey] of [['title', 'title'], ['request', 'body'], ['summary', 'summary']] as const) {
  assert.equal(proposal[key], canonical[key], fail); assert.equal(governance[indexKey], proposal[key], fail);
 }
 assert.ok(Array.isArray(proposal.evidenceRefs), fail);
 for (const source of canonical.source) {
  const [repository, number] = source.split('#'), url = 'https://github.com/' + repository + '/issues/' + number;
  assert.equal(proposal.evidenceRefs.filter((value: unknown) => row(value).store === 'url' && row(value).model === 'issue' && row(value).url === url).length, 1, fail);
 }
 const work = row(proposal.executionPlan).workItems; assert.ok(Array.isArray(work) && work.length === canonical.items.length, fail);
 assert.equal(new Set(work.map(value => JSON.stringify(row(value).acceptanceCriteria))).size, work.length, fail);
 for (const [index, value] of work.entries()) {
  const item = row(value), required = canonical.items[index]!;
  assert.equal(item.id, required.id, fail); assert.equal(item.workspace, required.workspace, fail);
  assert.equal(item.agentClass, required.role.toLowerCase().replace(/ /gu, '-'), fail);
  assert.equal(item.activity, 'acting', fail); assert.equal(item.review, 'required', fail);
  assert.equal(item.maximumReviewCycles, 2, fail); assert.deepEqual(item.dependsOn, [], fail);
  assert.equal(item.objective, required.objective, fail);
  if (sdk) assert.deepEqual(item.acceptanceCriteria, [sdk.workItems[index]!.acceptanceCriteria], fail);
  assert.ok(Array.isArray(item.requiredCapabilities) && item.requiredCapabilities.length > 0, fail);
  for (const field of ['estimate', 'reviewEstimate', 'ownerEstimate', 'reviewerEstimate'])
   assert.equal(Object.hasOwn(item, field), false, fail);
  assert.ok(Array.isArray(item.contextRefs), fail);
  const source = item.contextRefs.filter((reference: unknown) => row(reference).store === 'git' && row(reference).model === 'repository');
  assert.equal(source.length, 1, fail); assert.equal(row(source[0]).commit, expected.sourceCommit, fail);
  assert.equal(row(source[0]).repository, expected.sourceRepository, fail);
  const mutable = item.contextRefs.filter((reference: unknown) => row(reference).store === required.workspace && row(reference).model === 'repository');
  assert.equal(mutable.length, 1, fail);
  if (required.workspace === 'treedx') {
   assert.equal(row(mutable[0]).commit, expected.libraryCommit, fail);
   assert.equal(row(mutable[0]).repository, expected.libraryRepository, fail);
  }
 }
}

/** Reuse the selected freeze and public CLI; this function creates or rewrites nothing. */
export function readCampaignProposals(freeze: ReturnType<typeof readPreRunCampaignFreeze>, bindings: ReadonlyMap<string, Row>, team: string): Map<string, Row> {
 const document = readFileSync(resolve(process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH!, 'docs/agent-acceptance.md'), 'utf8');
 const observations = new Map<string, Row>();
 assert.ok(Array.isArray(freeze.manifest.proposals), fail);
 for (const proposal of freeze.manifest.proposals.map(row)) {
  const slug = String(proposal.slug), binding = bindings.get(slug); assert.ok(binding, fail);
  const projects = freeze.projects.filter(project => project.slug === slug); assert.equal(projects.length, 1, fail);
  const project = projects[0]!, bases = row(freeze.manifest.repositoryBases);
  assert.ok(typeof project.primaryRepository === 'string' && typeof project.libraryRepository === 'string', fail);
  const repository = (key: string) => {
   const matches = freeze.repositories.filter(value => value.key === key); assert.equal(matches.length, 1, fail);
   const url = new URL(matches[0]!.gitUrl); assert.equal(url.hostname, 'github.com', fail);
   return url.pathname.slice(1).replace(/\.git$/u, '');
  };
  const expected = { ...proposal, name: project.name.replace(/^TreeSeed /u, ''),
   sourceCommit: bases[project.primaryRepository], libraryCommit: bases[project.libraryRepository],
   sourceRepository: repository(project.primaryRepository), libraryRepository: repository(project.libraryRepository) };
  const governance = read(['proposals', 'show', String(proposal.id), '--project', slug, '--server', 'local'], team, true);
  console.log(JSON.stringify({ campaignProposalIndex: { slug, governance } }));
  const provenance = proposalProvenance(expected, binding, governance);
  const files = row(read(['library', 'read', slug, String(provenance.contentPath), '--ref', String(provenance.commitSha)], team, true).result);
  console.log(JSON.stringify({ campaignProposalFiles: { slug, files } }));
  verifyCampaignProjectProposal(expected, binding, governance, files, document);
  observations.set(slug, { governance, files });
 }
 assert.equal(observations.size, bindings.size, fail); assert.equal(observations.size, freeze.projects.length, fail);
 assert.equal(readFileSync(freeze.path, 'utf8'), freeze.bytes, fail);
 return observations;
}
