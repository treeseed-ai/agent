import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { row } from '../../../../../acceptance/acceptance-cli.ts';
import { verifyPredecessorCustody } from '../../../../../acceptance/workday/support/evidence-pages.ts';
import { verifyApprovedWorkReview, verifyReviewCandidateAuthority } from '../../../../../acceptance/workday/support/decision-evidence.ts';
import { contentReviewFailures, mutateContentReview, mutateReadiness, mutateReview, mutateReviewGrant, readinessFailures, reviewedDecision, reviewedGraphFixture, reviewedRevisionFixture, reviewFailures, reviewGrantFailures } from './review-readiness-fixture.ts';

it('native committed review sources and public SDK graph assignments deny missing approval custody before unchanged concurrent retry', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-reviewed-predecessor-')), f = reviewedGraphFixture();
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 }).trim();
	const sources = new Map<string, string>(), failures: Array<{ mode: string; failure: string }> = [];
	const requests: Array<{ path: string; body: string }> = []; let mode = 'exact', observationRef = '', candidateRef = '';
	const server = createServer((request, response) => {
		let bytes = ''; request.setEncoding('utf8'); request.on('data', chunk => { bytes += String(chunk); });
		request.on('end', () => {
			requests.push({ path: request.url ?? '', body: bytes }); response.setHeader('content-type', 'application/json');
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			if (mode === 'denied' || mode === 'unavailable') { response.writeHead(mode === 'denied' ? 403 : 503).end(JSON.stringify({ title: 'Retained native read failure' })); return; }
			if (mode === 'truncated') { response.end('{'); return; }
			if (request.method === 'POST') {
				const input = row(JSON.parse(bytes)); assert.ok(Array.isArray(input.paths));
				const candidate = input.paths[0] === 'candidate.txt';
				assert.deepEqual(input.paths, [candidate ? 'candidate.txt' : 'decisions/review.mdx']);
				assert.equal(input.ref, candidate ? candidateRef : mode.startsWith('revision')
					? input.ref === sources.get('disposition') ? sources.get('disposition') : sources.get('revision') : sources.get(mode) ?? sources.get('exact'));
				const content = execFileSync('git', ['show', `${input.ref}:${input.paths[0]}`], { cwd: root, encoding: 'utf8' });
				response.end(JSON.stringify({ data: { resolvedRef: input.ref, repoId: candidate ? 'native-source' : 'native-library', files: [{ path: input.paths[0], content,
					...(candidate ? {} : { frontmatter: parse(content.match(/^---\n([\s\S]*?)\n---/u)![1]!) }) }] } })); return;
			}
			const prefix = mode.startsWith('revision') ? 'revision-' : mode.startsWith('content') ? 'content-' : '';
			const graph = JSON.parse(git('show', `${observationRef}:${prefix}graph.json`)) as typeof f.graph;
			const assignments = JSON.parse(git('show', `${observationRef}:${prefix}assignments.json`)) as typeof f.assignments;
			const observed = { graph, assignments }; mutateReadiness(observed, mode); mutateReviewGrant(observed, mode); mutateContentReview(observed, mode);
			if (mode === 'revision-requested-write') mutateReviewGrant(observed, 'review-source-write');
			if (mode === 'revision-requested-context') mutateReviewGrant(observed, 'review-candidate-context');
			if (sources.has(mode) && mode !== 'revision') {
				const reference = observed.assignments[1]!.assignmentResult.references[0]!; assert.ok(reference.kind === 'treedx'); reference.commit = sources.get(mode)!;
			}
			const data = request.url?.includes('/capacity/assignments') ? { items: observed.assignments, page: { limit: 200, hasMore: false, nextCursor: null } } : observed.graph;
			response.end(JSON.stringify({ data }));
		});
	});
	try {
		git('init'); git('config', 'user.name', 'Native reviewed dependency fixture'); git('config', 'user.email', 'review@example.invalid');
		writeFileSync(join(root, 'candidate.txt'), 'Controlled original candidate bytes\n'); git('add', '.'); git('commit', '-m', 'Controlled candidate');
		const candidate = git('rev-parse', 'HEAD'); candidateRef = candidate;
		for (const item of [f.assignments[0]!, f.assignments[2]!]) {
			const reference = item.assignmentResult.references[0]!; assert.ok(reference.kind === 'git'); reference.commit = candidate;
		}
		f.assignments[1]!.assignmentAttempt.contextRefs[0]!.commit = candidate;
		mkdirSync(join(root, 'decisions'));
		for (const fault of ['exact', ...reviewFailures]) {
			const decision = reviewedDecision(f); mutateReview(decision, fault);
			writeFileSync(join(root, 'decisions/review.mdx'), `---\n${stringify(decision, { lineWidth: 0 })}---\nControlled native committed Decision.\n`);
			git('add', '.'); git('commit', '-m', `Controlled review ${fault}`); sources.set(fault, git('rev-parse', 'HEAD'));
		}
		const reference = f.assignments[1]!.assignmentResult.references[0]!; assert.ok(reference.kind === 'treedx'); reference.commit = sources.get('exact')!;
		const revised = reviewedRevisionFixture();
		for (const item of revised.assignments) for (const value of item.assignmentResult.references) {
			if (value.kind === 'git') value.commit = candidate;
			if (value.kind === 'treedx') value.commit = sources.get('disposition')!;
		}
		for (const item of revised.assignments.filter(value => value.assignmentAttempt.effectiveProfile.activity === 'reviewing'))
			item.assignmentAttempt.contextRefs[0]!.commit = candidate;
		const decision = reviewedDecision({ ...revised, assignments: [revised.assignments[2]!, revised.assignments[3]!, revised.assignments[4]!] });
		writeFileSync(join(root, 'decisions/review.mdx'), `---\n${stringify(decision, { lineWidth: 0 })}---\nControlled later approval.\n`);
		git('add', '.'); git('commit', '-m', 'Distinct later approval'); sources.set('revision', git('rev-parse', 'HEAD'));
		const approvalRef = revised.assignments[3]!.assignmentResult.references[0]!; assert.ok(approvalRef.kind === 'treedx'); approvalRef.commit = sources.get('revision')!;
		const contentGraph = reviewedGraphFixture('treedx'), contentRef = contentGraph.assignments[0]!.assignmentResult.references[0]!;
		assert.ok(contentRef.kind === 'treedx'); contentRef.commit = candidate;
		contentGraph.assignments[1]!.assignmentAttempt.contextRefs[0]!.commit = candidate;
		contentGraph.assignments[1]!.assignmentAttempt.grant.contentRead[0]!.commit = candidate;
		writeFileSync(join(root, 'decisions/review.mdx'), `---\n${stringify(reviewedDecision(contentGraph), { lineWidth: 0 })}---\nControlled content candidate approval.\n`);
		git('add', '.'); git('commit', '-m', 'Independent content candidate approval');
		const contentApproval = git('rev-parse', 'HEAD'), contentReviewRef = contentGraph.assignments[1]!.assignmentResult.references[0]!;
		assert.ok(contentReviewRef.kind === 'treedx'); contentReviewRef.commit = contentApproval;
		for (const fault of ['content', ...contentReviewFailures]) sources.set(fault, contentApproval);
		writeFileSync(join(root, 'content-graph.json'), JSON.stringify(contentGraph.graph)); writeFileSync(join(root, 'content-assignments.json'), JSON.stringify(contentGraph.assignments));
		writeFileSync(join(root, 'revision-graph.json'), JSON.stringify(revised.graph)); writeFileSync(join(root, 'revision-assignments.json'), JSON.stringify(revised.assignments));
		writeFileSync(join(root, 'graph.json'), JSON.stringify(f.graph)); writeFileSync(join(root, 'assignments.json'), JSON.stringify(f.assignments));
		git('add', '.'); git('commit', '-m', 'Original graph and assignment observation inputs'); observationRef = git('rev-parse', 'HEAD');
		const held = structuredClone({ f, revised, contentGraph }), tree = git('ls-tree', '-r', 'HEAD');
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); assert.ok(address && typeof address !== 'string');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-native-review' });
		const observe = async () => {
			const graph = row((await client.invoke(controlPlaneOperation('execution.graph.show'), { path: { teamId: f.graph.teamId }, query: {}, body: undefined })).data);
			const inventory = row((await client.invoke(controlPlaneOperation('assignments.list'), { path: { teamId: f.graph.teamId },
				query: { workdayId: f.assignments[0]!.workDayId, limit: 200 }, body: undefined })).data);
			assert.deepEqual(inventory.page, { limit: 200, hasMore: false, nextCursor: null }); assert.ok(Array.isArray(inventory.items));
			const assignments = inventory.items.map(row), before = structuredClone({ graph, assignments });
			try {
				const pairs = verifyPredecessorCustody(assignments, graph);
				for (const review of assignments.filter(item => row(row(item.lifecycleOutput).activityCompletion).reviewDisposition === 'request-changes')) {
					const ids = row(review.assignmentAttempt).predecessorResultIds; assert.ok(Array.isArray(ids));
					const actors = assignments.filter(item => row(row(item.assignmentAttempt).effectiveProfile).activity === 'acting' && ids.includes(row(item.assignmentResult).id));
					assert.equal(actors.length, 1); pairs.push({ review, actor: actors[0]! });
				}
				for (const { review, actor } of pairs) {
					const references = row(review.assignmentResult).references; assert.ok(Array.isArray(references));
					const reference = row(references[0]), observed = row((await client.invoke(controlPlaneOperation('treedx.repositories.files.read'), {
						path: { projectId: review.projectId, repoId: reference.repository }, query: {}, body: { ref: reference.commit, paths: [reference.path], encoding: 'utf8', parseFrontmatter: true } })).data);
					assert.equal(observed.resolvedRef, reference.commit); assert.ok(Array.isArray(observed.files) && observed.files.length === 1);
					const file = row(observed.files[0]), original = execFileSync('git', ['show', `${reference.commit}:${reference.path}`], { cwd: root, encoding: 'utf8' });
					assert.equal(file.content, original); const content = row(parse(original.match(/^---\n([\s\S]*?)\n---/u)![1]!));
					assert.deepEqual(file.frontmatter, content);
					if (row(row(review.lifecycleOutput).activityCompletion).reviewDisposition === 'approved') verifyApprovedWorkReview(review, actor, content);
					else { assert.equal(content.disposition, 'request-changes'); verifyReviewCandidateAuthority(review, content); }
					const subject = row(content.subjectRef);
					if (subject.store === 'git') assert.equal(git('show', `${subject.commit}:candidate.txt`), 'Controlled original candidate bytes');
					else {
						const candidateRead = row((await client.invoke(controlPlaneOperation('treedx.repositories.files.read'), { path: { projectId: review.projectId, repoId: subject.repository },
							query: {}, body: { ref: subject.commit, paths: [subject.path], encoding: 'utf8', parseFrontmatter: false } })).data);
						assert.equal(candidateRead.resolvedRef, subject.commit); assert.equal(candidateRead.repoId, subject.repository);
						assert.deepEqual(candidateRead.files, [{ path: subject.path, content: 'Controlled original candidate bytes\n' }]);
					}
				}
			} finally { expect({ graph, assignments }).toEqual(before); }
		};
		await Promise.all([observe(), observe()]);
		mode = 'revision'; await Promise.all([observe(), observe()]);
		mode = 'content'; await Promise.all([observe(), observe()]);
		for (const fault of [...readinessFailures, ...reviewFailures, ...reviewGrantFailures, ...contentReviewFailures,
			'revision-requested-write', 'revision-requested-context', 'denied', 'unavailable', 'truncated', 'interrupted']) {
			mode = fault; try { await observe(); failures.push({ mode, failure: 'unexpected pass' }); }
			catch (error) { failures.push({ mode, failure: String(error) }); }
		}
		expect(failures).toHaveLength(53); expect(failures.every(value => value.failure !== 'unexpected pass'), JSON.stringify(failures)).toBe(true);
		const retained = structuredClone(failures); mode = 'exact'; await Promise.all([observe(), observe()]);
		expect(failures).toEqual(retained); expect({ f, revised, contentGraph }).toEqual(held); expect(git('ls-tree', '-r', 'HEAD')).toBe(tree); expect(git('status', '--porcelain')).toBe('');
		expect(requests.length).toBeGreaterThan(29);
		// Actual Git/SDK/HTTP and owning assertions; supplied graph facts do not claim API producer or model execution.
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		rmSync(root, { recursive: true, force: true });
	}
	expect(server.listening).toBe(false); expect(existsSync(root)).toBe(false);
}, 30_000);
