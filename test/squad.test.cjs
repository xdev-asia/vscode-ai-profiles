const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readTask, SquadStore } = require('../dist/squad.js');

test('squad preserves other seats and handoffs when requests finish together', async () => {
  let stored;
  const storage = {
    get: () => stored,
    update: async (_key, value) => {
      await new Promise(resolve => setImmediate(resolve));
      stored = value;
    }
  };
  const board = new SquadStore(storage);
  const lead = readTask({ account: 'api:lead', brief: 'Propose a migration', status: 'Ready' });
  const implement = readTask({
    account: 'claude:work', brief: 'Update the API', status: 'Blocked', blocker: 'Need a schema decision'
  });
  await Promise.all([
    board.save('Lead', lead),
    board.save('Implement', implement),
    board.handoff('Lead', 'Review', 'Confirm public compatibility'),
    board.recordResponse('Lead', 'Plan from API')
  ]);

  const reloaded = new SquadStore(storage);
  assert.equal(reloaded.seat('Lead').response, 'Plan from API');
  assert.deepEqual(reloaded.seat('Implement'), { ...implement, response: undefined });
  assert.equal(reloaded.seat('Review').brief, '');
  assert.deepEqual(
    reloaded.read().activity.filter(event => event.to).map(({ from, to, message }) => [from, to, message]),
    [
      ['Lead', 'Review', 'Confirm public compatibility'],
      ['Implement', 'Lead', 'Need a schema decision']
    ]
  );

  await reloaded.save('Lead', { ...lead, status: 'Done' });
  assert.equal(reloaded.seat('Lead').response, 'Plan from API');
  await reloaded.save('Lead', { ...lead, brief: 'New task' });
  assert.equal(reloaded.seat('Lead').response, undefined);
});

test('a blocked task needs a brief and an escalation reason', () => {
  const task = { account: '', brief: '  ', status: 'Blocked', blocker: 'Waiting for input' };
  assert.throws(() => readTask(task), /task brief/);
  assert.throws(() => readTask({ ...task, brief: 'Implement change', blocker: ' ' }), /blocking the task/);
  assert.equal(readTask({ ...task, status: 'Ready' }).blocker, '');
});
