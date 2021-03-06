# Tasklets
## Alternative API for Promises designed for TypeScript.

```typescript
import { make, gather, Tasklet } from '@aliclark/tasklets'

(async () => {
    const homeId = 42

    interface House {
        kitchenId: string
        loungeId: string
    }

    interface Home {
        house: House
        kitchen: string
        lounge: string
    }

    const getHouse: Tasklet<House> = make(done =>
        setTimeout(() => done({ kitchenId: `${homeId}k`, loungeId: `${homeId}l` }), 1)
    )

    // The unhandled error will be console.warn'd
    make(done => {
        console.log('logging something')
        done(new Error('some logging error'))
    })

    const getHome: Tasklet<Home> = gather({
        house: getHouse,
        kitchen: getHouse.and(({ kitchenId }) => then => setTimeout(() => then(`kitchen ${kitchenId}`), 1)),
        lounge: getHouse.and(({ loungeId }) => then => setTimeout(() => then(`lounge ${loungeId}`), 1)),
    })

    const home = await getHome.or(error => otherwise => {
        console.error('failed to get the home')
        otherwise(error)
    })

    console.log(home)
})()
```

```sh
yarn add @aliclark/tasklets
```
