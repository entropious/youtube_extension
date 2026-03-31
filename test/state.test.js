"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const chai_1 = require("chai");
class SimpleMockMemento {
    constructor() {
        this.data = {};
    }
    get(key, defaultValue) {
        return this.data[key] !== undefined ? this.data[key] : defaultValue;
    }
    async update(key, value) {
        this.data[key] = value;
    }
}
describe('Mock State Tests', () => {
    it('should correctly store and retrieve data in MockMemento', async () => {
        const memento = new SimpleMockMemento();
        await memento.update('test', 123);
        (0, chai_1.expect)(memento.get('test', 0)).to.equal(123);
    });
});
//# sourceMappingURL=state.test.js.map