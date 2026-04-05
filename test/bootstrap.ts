import * as sinon from 'sinon';
import * as path from 'path';

/**
 * Mocking the vscode global for unit tests.
 */
const vscodeMock: any = {
    window: {
        createWebviewPanel: sinon.stub(),
        registerWebviewViewProvider: sinon.stub(),
        registerWebviewPanelSerializer: sinon.stub(),
        showInputBox: sinon.stub()
    },
    commands: {
        registerCommand: sinon.stub()
    },
    Uri: {
        file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
        parse: (url: string) => ({ fsPath: url, scheme: 'url', toString: () => url }),
        joinPath: (uri: any, ...paths: string[]) => ({ 
            fsPath: path.join(uri.fsPath, ...paths),
            toString: () => `${uri.toString()}/${paths.join('/')}`
        })
    },
    ViewColumn: {
        One: 1, Two: 2, Three: 3
    },
    EventEmitter: class {
        event = sinon.stub();
        fire = sinon.stub();
    },
    CancellationTokenSource: class {
        token = {};
        cancel = sinon.stub();
    }
};

// Handle node modules mock
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Module = require('module');
const originalLoad = Module._load;

Module._load = function(request: string, parent: any, isMain: boolean) {
    if (request === 'vscode') {
        return vscodeMock;
    }
    return originalLoad.apply(this, [request, parent, isMain]);
};

export default vscodeMock;
