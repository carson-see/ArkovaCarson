/**
 * Arkova Zapier Integration (INT-05)
 *
 * Triggers: anchor.secured, anchor.revoked (via webhooks)
 * Actions: Anchor Document, Verify Credential, Batch Verify
 * Auth: API Key (X-API-Key header)
 */

import { authentication } from './authentication';
import { anchorSecuredTrigger } from './triggers/anchorSecured';
import { anchorRevokedTrigger } from './triggers/anchorRevoked';
import { anchorDocumentAction } from './actions/anchorDocument';
import { verifyCredentialAction } from './actions/verifyCredential';
import { batchVerifyAction } from './actions/batchVerify';

const App = {
  version: '1.0.0',
  platformVersion: '15.0.0',

  authentication,

  triggers: {
    [anchorSecuredTrigger.key]: anchorSecuredTrigger,
    [anchorRevokedTrigger.key]: anchorRevokedTrigger,
  },

  actions: {
    [anchorDocumentAction.key]: anchorDocumentAction,
    [verifyCredentialAction.key]: verifyCredentialAction,
    [batchVerifyAction.key]: batchVerifyAction,
  },

  searches: {},
  resources: {},
};

export default App;
