/**
 * The library behind the afrec CLI, for other front ends (a future `sf agent record` plugin, CI scripts):
 *
 *   const project = loadProject();
 *   const { conversations, errors } = planRun({ project, inputs: ['scenarios/'] });
 *   const { results, out } = await executeRun(conversations, { project, emit: e => console.log(e) });
 */
export { loadProject, saveConfig, findProjectDir } from './config.js';
export { readScenarioFiles, parseScenarioText, parseMarkdown, parseCsv, toMarkdown } from './scenario/parse.js';
export { resolveConversation, resolveAll, assignFolders } from './scenario/resolve.js';
export { draftFacts, draftSettings, draftFile, draftScenario, writeDraft } from './scenario/draft.js';
export { agentTopics } from './engine/salesforce.js';
export { planRun, describePlan, executeRun } from './engine/run.js';
export { InputBroker, promptOnTerminal } from './engine/input.js';
export { compareRuns, readRun, wordDiff } from './engine/baseline.js';
export { allPacks, selectPack, effectivePack, releaseName, checkPack } from './selectors/packs.js';
export { updatePacks, promote, packStatus } from './selectors/manage.js';
export { doctorCheck, describeDoctor } from './doctor/doctor.js';
export { writeHealBundle } from './doctor/bundle.js';
export { listFixtures, testFixture, fixtureFromDoctor } from './doctor/fixtures.js';
export { startServer } from './ui/server.js';
