import { view } from './kit.js';

export const { WD, CONFIG, DIRS, UI_STATE, ARCHIVED, cardName, getProjects, getRoadmap, getIssues, getCard, getDetail, getFlows, setArchived, setMilestoneFold, renameProject, trashProject } = await view('workdash.js');
