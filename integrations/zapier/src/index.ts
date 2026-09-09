/**
 * Arkova Zapier Integration (INT-05)
 *
 * Triggers: anchor.secured, anchor.revoked (via webhooks)
 * Actions: Anchor Document, Verify Anchor, Batch Verify
 * Auth: API Key (X-API-Key header)
 */

import { authentication } from './authentication';
import { anchorSecuredTrigger } from './triggers/anchorSecured';
import { anchorRevokedTrigger } from './triggers/anchorRevoked';
import { anchorDocumentAction } from './actions/anchorDocument';
import { verifyAnchorAction } from './actions/verifyAnchor';
import { batchVerifyAction } from './actions/batchVerify';

const App = {
  version: '1.0.0',
  platformVersion: '18.6.0',

  authentication,

  triggers: {
    [anchorSecuredTrigger.key]: anchorSecuredTrigger,
    [anchorRevokedTrigger.key]: anchorRevokedTrigger,
  },

  creates: {
    [anchorDocumentAction.key]: anchorDocumentAction,
    [verifyAnchorAction.key]: verifyAnchorAction,
    [batchVerifyAction.key]: batchVerifyAction,
  },

  searches: {},
  resources: {},
};

export default App;
