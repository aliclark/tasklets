import { make, gather, Tasklet } from '../src'

describe('Tasklet', () => {

    it('continues', async() => {
        const tasklet: Tasklet<number> = make(done => done(1))
        expect(await tasklet.and(input => then => then(`result ${input * 2}`))).toBe('result 2')
    })
})
