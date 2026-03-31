import { expect } from 'chai';

// Skip this for now or find a way to mock vscode if it's not present
// For now, I'll mock the Memento interface itself.

interface MockMemento {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: any): Promise<void>;
}

class SimpleMockMemento implements MockMemento {
    data: Record<string, any> = {};
    get<T>(key: string, defaultValue: T): T {
        return this.data[key] !== undefined ? this.data[key] : defaultValue;
    }
    async update(key: string, value: any): Promise<void> {
        this.data[key] = value;
    }
}

describe('Mock State Tests', () => {
    it('should correctly store and retrieve data in MockMemento', async () => {
        const memento = new SimpleMockMemento();
        await memento.update('test', 123);
        expect(memento.get('test', 0)).to.equal(123);
    });
});
