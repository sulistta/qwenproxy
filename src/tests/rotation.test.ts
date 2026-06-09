import { test } from 'node:test';
import assert from 'node:assert';
import {
  getNextAccount,
  setAccountManagerAccountsForTests,
} from '../core/account-manager.ts';

test('Account Rotation: Round-Robin rotation cycle', async () => {
  const mockAccounts = [
    { id: 'account-1', email: 'account1@test.com', password: 'password1' },
    { id: 'account-2', email: 'account2@test.com', password: 'password2' },
    { id: 'account-3', email: 'account3@test.com', password: 'password3' },
  ];

  try {
    setAccountManagerAccountsForTests(mockAccounts);

    const first = getNextAccount(true);
    const second = getNextAccount();
    const third = getNextAccount();
    const fourth = getNextAccount();

    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.ok(fourth);

    assert.strictEqual(first.email, 'account1@test.com');
    assert.strictEqual(second.email, 'account2@test.com');
    assert.strictEqual(third.email, 'account3@test.com');
    assert.strictEqual(fourth.email, 'account1@test.com');
  } finally {
    setAccountManagerAccountsForTests(null);
  }
});
