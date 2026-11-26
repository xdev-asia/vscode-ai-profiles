const assert = require('node:assert/strict');
const { test } = require('node:test');
const manifest = require('../package.json');
const { approvalSettings } = require('../dist/squad-chat.js');

const setting = key => manifest.contributes.configuration.properties[key];

test('a new install waits for the user: plans are approved by hand and every step is started by the user', () => {
  assert.equal(setting('xdevAi.squad.planApproval').default, 'manual');
  assert.equal(setting('xdevAi.squad.approver').default, 'human');
});

test('unset or unknown approval settings never start a run or a step without the user', () => {
  assert.deepEqual(approvalSettings(() => undefined), { planApproval: 'manual', approver: 'human' });
  assert.deepEqual(approvalSettings(key => ({ planApproval: 'AUTO', approver: 'robot' })[key]), { planApproval: 'manual', approver: 'human' });
  assert.deepEqual(approvalSettings(key => ({ planApproval: 'auto', approver: 'ai' })[key]), { planApproval: 'auto', approver: 'ai' },
    'automation stays available when the user turns it on');
  assert.deepEqual(approvalSettings(key => ({ approver: 'ai+human' })[key]), { planApproval: 'manual', approver: 'ai+human' });
});
