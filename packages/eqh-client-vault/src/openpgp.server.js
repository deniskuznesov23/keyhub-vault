const fs = require('fs')

const openpgp = require('openpgp') // use as CommonJS, AMD, ES6 module or via window.openpgp

const hkp = new openpgp.HKP('https://pgp.mit.edu')

openpgp.initWorker({ path: 'openpgp.worker.js' }) // set the relative web worker path

const FILEPATH_TO_KEYPAIR = './new-pgp-key-pair'
const FILEPATH_TO_SIGN = 'dist/index.bundle.js'

const options = {
  userIds: [
    { name: 'EQH', email: 'eqh@bcz.app' },
  ], // support multiple user IDs
  curve: 'ed25519',
  passphrase: 'our super long and mighty hard to guess secret',
}

// Generate new keyPair
openpgp.generateKey(options)
  .then((key) => {
    console.log('keypair generated!') // eslint-disable-line no-console
    if (fs.existsSync(`${FILEPATH_TO_KEYPAIR}.key.asc`)) return null
    return hkp.upload(key.publicKeyArmored).then(() => key)
  })
  .then((key) => {
    if (key) {
      console.log('publicKey uploaded!') // eslint-disable-line no-console
      fs.writeFileSync(`${FILEPATH_TO_KEYPAIR}.key.asc`, key.privateKeyArmored)
      fs.writeFileSync(`${FILEPATH_TO_KEYPAIR}.pub.asc`, key.publicKeyArmored)
      fs.writeFileSync(`${FILEPATH_TO_KEYPAIR}.rev.asc`, key.revocationSignature)
    }

    return fs.readFileSync(`${FILEPATH_TO_KEYPAIR}.key.asc`, 'utf8')
  })
  .then((privkey) => {
    const privKeyObj = openpgp.key.readArmored(privkey).keys[0]
    return privKeyObj.decrypt(options.passphrase).then(() => privKeyObj)
  })
  .then((privKeyObj) => {
    const opts = {
      data: fs.readFileSync(FILEPATH_TO_SIGN, 'utf8'),
      privateKeys: [privKeyObj],
      detached: true,
    }

    console.log('signing...') // eslint-disable-line no-console
    return openpgp.sign(opts)
  })
  .then((signed) => {
    console.log('signed:', FILEPATH_TO_SIGN) // eslint-disable-line no-console
    fs.writeFileSync(`${FILEPATH_TO_SIGN}.sig.asc`, signed.signature)
    return true
  })

// eslint-disable-next-line import/no-extraneous-dependencies
const ssri = require('ssri')

ssri.fromStream(fs.createReadStream('dist/openpgp.worker.bundle.js'))
  .then((sri) => {
    console.log('sri of openpgp.worker.bundle.js:', sri.toString()) // eslint-disable-line no-console
  })
