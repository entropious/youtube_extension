import * as sinon from 'sinon';

/**
 * Mocks for VS Code API objects for testing YouTubeViewProvider.
 */

export class MockMemento {
    data: Record<string, any> = {};
    get<T>(key: string, defaultValue?: T): T {
        return this.data[key] !== undefined ? this.data[key] : (defaultValue as T);
    }
    async update(key: string, value: any): Promise<void> {
        this.data[key] = value;
    }
}

export function createMockWebview() {
    return {
        postMessage: sinon.stub().resolves(true),
        onDidReceiveMessage: sinon.stub().returns({ dispose: () => {} }),
        asWebviewUri: sinon.stub().returns({ toString: () => 'mock-uri' }),
        cspSource: 'mock-csp',
        html: '',
        options: {}
    };
}

export function createMockWebviewView(webview: any) {
    return {
        webview,
        visible: true,
        onDidDispose: sinon.stub(),
        onDidChangeVisibility: sinon.stub().returns({ dispose: () => {} }),
        show: sinon.stub()
    };
}

export function createMockWebviewPanel(webview: any) {
    return {
        webview,
        visible: true,
        title: 'Mock Panel',
        onDidDispose: sinon.stub(),
        onDidChangeViewState: sinon.stub().returns({ dispose: () => {} }),
        reveal: sinon.stub(),
        dispose: sinon.stub()
    };
}
