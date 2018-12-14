import { safeHtml, stripIndent } from 'common-tags'

import postRobot from 'post-robot'

import pRetry from 'p-retry'

import VaultWorker from './vault.worker'

import {
  WelcomeScreen,
  LoadingScreen,
  KeyAddScreen,
  KeyRestoreScreen,
  PassphraseDisplayScreen,
  PassphraseConfirmScreen,
  PhonenumConfirmScreen,
  TxDetailScreen,
  SuccessScreen,
  KeyDetailScreen,
} from './screen'

const { callOnStore } = require('./util/indexeddb')

const { postMessage } = require('./util/webworker')

const { drawText, getImageData } = require('./util/canvas')

export default function loadVault(window, document, mainElement) {
  // VaultWorker singletons from multiple networks
  // One platform might run multiple networks (e.g. mainnet)
  const workers = Object.create(null)

  const vaultLayoutHTML = safeHtml`<div class="container fade-in" id="mainWrapper">
    <div class="row" >
      <div class="sidebar col-md-4 bg-grey py-3 d-none" id="sidebar">
        <div class="block-title">Keys in this browser's wallet</div>
        <div id="key-list" class="key-list"></div>
        <button class="btn btn-secondary btn-sm ml-1" id="goto-add-key-btn">Add / Restore Key</button>
      </div>
      <div class="col-md-8 offset-md-2 bg-white main-content" id="mainContent">
        <div class="entry-page py-3" id="content"></div>
      </div>
    </div>
  </div>`

  mainElement.innerHTML = vaultLayoutHTML // eslint-disable-line no-param-reassign

  const contentDiv = document.getElementById('content')
  const sidebarDiv = document.getElementById('sidebar')
  const keyListDiv = document.getElementById('key-list')
  const mainWrapper = document.getElementById('mainWrapper')
  const mainContent = document.getElementById('mainContent')

  let welcomeDiv

  const activateNetwork = (networkName, address) => {
    // Lazy-Load Webworker
    if (!workers[networkName]) workers[networkName] = new VaultWorker()
    const worker = workers[networkName]

    // call configure on background webworker to get current config
    return postMessage(worker, ['configure', { networkName, address }]).then(config => ({
      worker,
      config,
    }))
  }

  const showGenerateUnprotectedKeyScreen = (platform, network, phonenum) =>
    activateNetwork(network).then(({ worker }) => {
      const message = stripIndent`
        We will text the seed-passphrase to your phone for backup purpose.
        SMS might be intercepted by an unknown third-party.`

      const pubkey = stripIndent`
      -----BEGIN PGP PUBLIC KEY BLOCK-----
      Version: OpenPGP.js v3.1.0
      Comment: https://openpgpjs.org

      xjMEW87lXhYJKwYBBAHaRw8BAQdAlIyAn31pcSBfq8JL+OZhxSJqNpce5kMR
      RT/Em2MvjTLNLGVxaCBLZXlIdWIgU01TIDxlcWguc21zQHBsYXRmb3JtLmtl
      eWh1Yi5hcHA+wncEEBYKACkFAlvO5V4GCwkHCAMCCRCfbznlpPf4PAQVCAoC
      AxYCAQIZAQIbAwIeAQAALuEBAOUe2KkUZA8ORr2i8AWOvmD3YYaZNlL2SNKS
      hDemF6tsAQDNBuQ9kmtK/c617kkqRDJu9PUsVvKUdf9SFqH6v+p/BM44BFvO
      5V4SCisGAQQBl1UBBQEBB0Dz1rTzNxVIZkybI8Kuc5+X9JZebkY0iSjA2D3N
      cf7PSQMBCAfCYQQYFggAEwUCW87lXgkQn2855aT3+DwCGwwAAHZSAP920Slk
      V4q8Z3ZY+trryvESUBpSqoWMhKJlUlhP4pvp4wEAgmTTx5Dl5K4YRvEMeh5O
      DZazk+YohUxifYrpNHuVjgU=
      =Qpzm
      -----END PGP PUBLIC KEY BLOCK-----
    `

      const [div, promise] = PhonenumConfirmScreen(document, phonenum, message)
      contentDiv.innerHTML = ''
      contentDiv.appendChild(div)

      return promise.then(([choice, phoneNumber]) => {
        contentDiv.innerHTML = ''
        contentDiv.appendChild(LoadingScreen(document, `Generating ${platform} Key`))

        return postMessage(worker, ['generatePassphrase', 10])
          .then(passphrase => `${platform.toLowerCase()} ${passphrase}`)
          .then(passphrase => {
            if (choice === 'skip') return { passphrase }
            // TODO: Updated OpenPGP version has breaking changes to API
            const openpgp = (window && window.openpgp) || global.openpgp
            const options = {
              data: passphrase,
              publicKeys: openpgp.key.readArmored(pubkey).keys,
              compression: openpgp.enums.compression.zlib,
            }
            return openpgp
              .encrypt(options)
              .then(({ data: encPassphrase }) => ({ passphrase, encPassphrase }))
          })
          .then(({ passphrase, encPassphrase }) => {
            contentDiv.innerHTML = ''
            contentDiv.appendChild(LoadingScreen(document, 'Storing Key in Browser'))
            const ctx = document.createElement('canvas').getContext('2d')
            const passphraseImage = getImageData(drawText(ctx, passphrase, 400))

            return postMessage(worker, [
              'storeUnprotectedKey',
              network,
              passphrase,
              passphraseImage,
            ]).then(({ id, address, accountNo, publicKey }) =>
              !encPassphrase
                ? {
                    id,
                    address,
                    accountNo,
                    publicKey,
                  }
                : {
                    id,
                    address,
                    accountNo,
                    publicKey,
                    phoneNumber,
                    encPassphrase,
                  }
            )
          })
      })
    })

  const showGenerateKeyScreen = (platform, network) =>
    activateNetwork(network).then(({ worker }) => {
      contentDiv.innerHTML = ''
      contentDiv.appendChild(LoadingScreen(document, `Generating Passphrase for ${platform}`))

      // call generatePassphrase on background webworker
      const p = postMessage(worker, ['generatePassphrase', 10]).then(
        passphrase => `${platform.toLowerCase()} ${passphrase}`
      )

      return p
        .then(passphrase => {
          const [div, promise] = PassphraseDisplayScreen(document, network, passphrase)
          contentDiv.innerHTML = ''
          contentDiv.appendChild(div)
          return promise
        })
        .then(([choice, passphrase]) => {
          if (choice !== 'ok') throw new Error('cancelled by user')

          const [div, promise] = PassphraseConfirmScreen(document, passphrase, true)
          contentDiv.innerHTML = ''
          contentDiv.appendChild(div)

          return promise.then(([choice2, pin]) => {
            if (choice2 !== 'ok') throw new Error('cancelled by user')

            contentDiv.innerHTML = ''
            contentDiv.appendChild(
              LoadingScreen(document, 'Securely Storing your Key in this Browser')
            )

            // call createKeyPair on background webworker
            return postMessage(worker, ['storeProtectedKey', network, passphrase, pin]).then(
              ({ id, address, accountNo, publicKey }) => ({
                id,
                address,
                accountNo,
                publicKey,
                pin,
              })
            )
          })
        })
    })

  const showAddKeyScreen = () => {
    const [div, promise] = KeyAddScreen(document)
    contentDiv.innerHTML = ''
    contentDiv.appendChild(div)
    return promise.then(({ platform, network }) => showGenerateKeyScreen(platform, network))
  }

  const showRestoreMissingKeyScreen = (platform, network, desiredAddress) =>
    activateNetwork(network).then(({ worker }) => {
      const message = stripIndent`
        Key for ${desiredAddress} is missing from this browser.
        Please restore your ${network} key using a backup of your seed-passphrase.`

      const [div, promise] = KeyRestoreScreen(
        document,
        'Key Missing',
        message,
        platform,
        desiredAddress,
        passphrase => postMessage(worker, ['getPassphraseInfo', passphrase])
      )
      contentDiv.innerHTML = ''
      contentDiv.appendChild(div)

      return promise.then(([choice, passphrase]) => {
        if (choice !== 'ok') throw new Error('cancelled by user')
        contentDiv.innerHTML = ''
        contentDiv.appendChild(LoadingScreen(document, 'Storing Key in Browser'))
        const ctx = document.createElement('canvas').getContext('2d')
        const passphraseImage = getImageData(drawText(ctx, passphrase, 400))

        return postMessage(worker, [
          'storeUnprotectedKey',
          network,
          passphrase,
          passphraseImage,
        ]).then(({ id, address, accountNo, publicKey }) => ({
          id,
          address,
          accountNo,
          publicKey,
        }))
      })
    })

  const getKeyDetail = (network, entryId) =>
    activateNetwork(network).then(({ worker }) =>
      // call getKeyPair on background webworker
      postMessage(worker, ['getStoredKeyInfo', entryId]).then(
        ({ address, accountNo, publicKey, hasPinProtection, hasPassphrase }) => {
          if (!hasPassphrase) {
            return {
              network,
              address,
              accountNo,
              publicKey,
              hasPinProtection,
            }
          }

          return postMessage(worker, ['getStoredKeyPassphrase', entryId]).then(passphraseImage => ({
            network,
            address,
            accountNo,
            publicKey,
            hasPinProtection,
            passphraseImage,
          }))
        }
      )
    )

  const signTransaction = (network, address, tx, optionalPin = null) =>
    activateNetwork(network).then(({ worker }) => {
      contentDiv.innerHTML = ''
      contentDiv.appendChild(LoadingScreen(document, 'Signing Transaction'))

      return postMessage(worker, ['signTransaction', address, tx.type, tx.data, optionalPin]).then(
        ({ transactionBytes, transactionJSON, transactionFullHash }) => ({
          transactionBytes,
          transactionJSON,
          transactionFullHash,
        })
      )
    })

  const signMessage = (network, address, message, optionalPin = null) =>
    activateNetwork(network).then(({ worker }) => {
      contentDiv.innerHTML = ''
      contentDiv.appendChild(LoadingScreen(document, 'Signing Document'))

      // call signMessage on background worker
      return postMessage(worker, ['signMessage', address, message, optionalPin]).then(
        ({ signature }) => signature
      )
    })

  const updateKeyListDiv = () =>
    new Promise((resolve, reject) => {
      try {
        callOnStore('accounts', accounts => {
          const req = accounts.getAll()
          req.onsuccess = ({ target: { result: entries } }) => {
            if (Array.isArray(entries) && entries.length > 0) {
              // Group by network name
              const keysByNetwork = entries.reduce((acc, entry) => {
                const g = acc[entry.network || entry.platform]
                if (g) g.push(entry)
                else acc[entry.network || entry.platform] = [entry]
                return acc
              }, {})

              // onClick handler for <ul/>
              const onClick = ul => ({ target: { type, dataset, classList } }) => {
                if (type === 'button' && dataset) {
                  const { network, address, entryId } = dataset
                  activateNetwork(network, address)
                    .then(() => {
                      ul.querySelectorAll('button').forEach(
                        li => li.classList.remove('btn-dark') && li.classList.add('btn-light')
                      )
                      classList.remove('btn-light')
                      classList.add('btn-dark')
                      return getKeyDetail(network, entryId).then(keyDetail => {
                        const [div] = KeyDetailScreen(document, keyDetail)
                        contentDiv.innerHTML = ''
                        contentDiv.appendChild(div)
                      })
                    })
                    .catch(error => {
                      window.alert(error.message || error)
                    })
                }
              }

              keyListDiv.innerHTML = ''
              Object.keys(keysByNetwork).forEach(network => {
                const div = document.createElement('div')
                const h3 = document.createElement('h3')
                h3.appendChild(document.createTextNode(network))
                div.appendChild(h3)
                const ul = document.createElement('ul')
                ul.addEventListener('click', onClick(ul))

                const plaformKeys = keysByNetwork[network]
                plaformKeys.forEach(entry => {
                  const li = document.createElement('li')
                  const button = document.createElement('button') // eslint-disable-line
                  button.type = 'button'
                  button.classList.add('btn', 'btn-light')
                  button.appendChild(document.createTextNode(entry.address))
                  button.dataset.network = entry.network
                  button.dataset.address = entry.address
                  button.dataset.entryId = entry.id
                  li.appendChild(button)
                  ul.appendChild(li)
                })

                div.appendChild(ul)
                keyListDiv.appendChild(div)
              })

              resolve(true)
            } else {
              resolve(false)
            }
          }
        })
      } catch (err) {
        reject(err)
      }
    })

  // Add Event Listener: User clicks "Add Key" Button
  document.getElementById('goto-add-key-btn').addEventListener('click', () => {
    showAddKeyScreen()
      .then(() => updateKeyListDiv())
      .then(() => {
        contentDiv.innerHTML = ''
        contentDiv.appendChild(welcomeDiv)
      })
      .catch(error => {
        if (error.message !== 'cancelled by user') {
          window.alert(error.message || error)
        }
        contentDiv.innerHTML = ''
        contentDiv.appendChild(welcomeDiv)
      })
  })

  // Handle Cross-Tab Actions from postRobot
  const triggerAction = (action, params, callback) => {
    // Trigger A: App wants to create new unprotected key for user
    // Input: { action: 'newUnprotectedKeyAndSign', params: { platform: 'EQH', network: 'Equinehub', messageHex: '', phoneNumber: '' } }
    // Output: { publicKey, signature }
    if (action === 'newUnprotectedKeyAndSign' && params) {
      const { platform, network, messageHex, phoneNum = '' } = params
      if (!platform) throw new Error(`invalid platform ${platform}`)
      if (!network) throw new Error(`invalid network ${network}`)
      if (!messageHex) throw new Error(`invalid messageHex ${messageHex}`)

      return showGenerateUnprotectedKeyScreen(platform, network, phoneNum)
        .then(res => updateKeyListDiv().then(() => res))
        .then(({ address, publicKey, phoneNumber, encPassphrase }) =>
          signMessage(network, address, messageHex).then(signature => {
            contentDiv.innerHTML = ''
            contentDiv.appendChild(LoadingScreen(document, 'Registering Key'))
            // callback to the parent window with result
            const run = () =>
              callback(null, {
                address,
                publicKey,
                signature,
                phoneNumber,
                encPassphrase,
              })
            return pRetry(run, {
              retries: 5,
              factor: 1.71,
              onFailedAttempt: error => {
                contentDiv.innerHTML = ''
                contentDiv.appendChild(
                  LoadingScreen(
                    document,
                    `Registering Key (attempt: ${error.attemptNumber})`,
                    `Error in Main App: ${error.message || error}`
                  )
                )
              },
            })
          })
        )
        .then(() => self.close()) // eslint-disable-line
        .catch(error => {
          // if (error.message !== 'cancelled by user') {
          //   window.alert(error.message || error)
          // }

          // callback to the parent window on error
          callback(error)
            .then(() => {
              self.close() // eslint-disable-line
            })
            .catch(err => {
              window.alert(`Could not return error to parent window: ${err.message || err}`)
            })
        })
    }

    // Trigger B: App wants to create new key for user
    // Input: { action: 'newKeyAndSign', params: { platform: 'EQH', network: 'Main', messageHex: '' } }
    // Output: { publicKey, signature }
    if (action === 'newKeyAndSign' && params) {
      const { platform, network, messageHex } = params
      if (!platform) throw new Error(`invalid platform ${platform}`)
      if (!network) throw new Error(`invalid network ${network}`)
      if (!messageHex) throw new Error(`invalid messageHex ${messageHex}`)

      return showGenerateKeyScreen(platform, network)
        .then(res => updateKeyListDiv().then(() => res))
        .then(({ address, publicKey, pin }) =>
          signMessage(network, address, messageHex, pin).then(signature => {
            contentDiv.innerHTML = ''
            contentDiv.appendChild(LoadingScreen(document, 'Registering Key'))
            // callback to the parent window with result
            const run = () =>
              callback(null, {
                address,
                publicKey,
                signature,
              })
            return pRetry(run, {
              retries: 5,
              factor: 1.71,
              onFailedAttempt: error => {
                contentDiv.innerHTML = ''
                contentDiv.appendChild(
                  LoadingScreen(
                    document,
                    `Registering Key (attempt: ${error.attemptNumber})`,
                    `Error in Main App: ${error.message || error}`
                  )
                )
              },
            })
          })
        )
        .then(() => {
          const message =
            'Key Added. Thank you for using our Open-source Vault. You will be returned to the main app.'
          const [div, promise] = SuccessScreen(document, 'Thank You', message, 1000)
          contentDiv.innerHTML = ''
          contentDiv.appendChild(div)
          return promise
        })
        .then(() => self.close()) // eslint-disable-line
        .catch(error => {
          // if (error.message !== 'cancelled by user') {
          //   window.alert(error.message || error)
          // }

          // callback to the parent window on error
          callback(error)
            .then(() => {
              self.close() // eslint-disable-line
            })
            .catch(err => {
              window.alert(`Could not return error to parent window: ${err.message || err}`)
            })
        })
    }

    // Trigger C: App wants to display key detail screen
    // Input: { action: 'showKeyDetail', params: { platform: 'EQH', network: 'Equinehub', id: 'EQH-xxx-xxx-xxx-xxx' } }
    // Output: { hasKeyPair: true, hasPassphrase: false }
    if (action === 'showKeyDetail' && params) {
      const { platform, network, id: entryId } = params
      if (!platform) throw new Error(`invalid platform ${platform}`)
      if (!network) throw new Error(`invalid network ${network}`)
      if (!entryId) throw new Error(`invalid id ${entryId}`)

      return getKeyDetail(network, entryId)
        .catch(err => {
          if (!err.message.includes('missing')) throw err
          // callback to the parent window with key state before restore
          callback(null, {
            hasKeyPair: false,
            hasPassphrase: false,
          })
          return showRestoreMissingKeyScreen(platform, network, entryId).then(() =>
            getKeyDetail(network, entryId)
          )
        })
        .then(keyDetail => {
          // callback to the parent window with result after restore
          callback(null, {
            hasKeyPair: !!keyDetail.publicKey,
            hasPassphrase: !!keyDetail.passphraseImage,
          })
          return keyDetail
        })
        .then(keyDetail => {
          const [div, promise] = KeyDetailScreen(document, keyDetail)
          contentDiv.innerHTML = ''
          contentDiv.appendChild(div)
          return promise.then(choice => {
            if (choice === 'ok') self.close() // eslint-disable-line
          })
        })
        .catch(error => {
          // if (error.message !== 'cancelled by user' && error.message !== 'key missing') {
          //   window.alert(error.message || error) // eslint-disable-line
          // }

          // callback to the parent window on error
          callback(error)
            .then(() => {
              self.close() // eslint-disable-line
            })
            .catch(err => {
              window.alert(`Could not return error to parent window: ${err.message || err}`)
            })
        })
    }

    // Trigger D: App wants to sign transaction
    // Input: { action: 'signTx', params: { platform: 'EQH', network: 'Equinehub', id: 'EQH-xxx-xxx-xxx-xxx', tx: {} } }
    // Output: { transactionBytes, transactionJSON, transactionFullHash }
    if (action === 'signTx' && params) {
      const { platform, network, id: entryId, tx } = params
      if (!platform) throw new Error(`invalid platform ${platform}`)
      if (!network) throw new Error(`invalid network ${network}`)
      if (!entryId) throw new Error(`invalid id ${entryId}`)
      if (typeof tx !== 'object') throw new Error(`invalid tx ${tx}`)

      return getKeyDetail(network, entryId)
        .catch(err => {
          if (!err.message.includes('missing')) throw err
          // callback to the parent window with key state before restore
          callback(null, {
            hasKeyPair: false,
            hasPassphrase: false,
          })
          return showRestoreMissingKeyScreen(platform, network, entryId).then(() =>
            getKeyDetail(network, entryId)
          )
        })
        .then(keyDetail => {
          // callback to the parent window with result after restore
          callback(null, {
            hasKeyPair: !!keyDetail.publicKey,
            hasPassphrase: !!keyDetail.passphraseImage,
          })
          return keyDetail
        })
        .then(({ accountNo, address, hasPinProtection }) => {
          const [div, promise] = TxDetailScreen(
            document,
            platform,
            accountNo,
            address,
            tx,
            hasPinProtection
          )
          const loadingDiv = LoadingScreen(document, `Signing Transaction`)
          loadingDiv.classList.add('d-none')

          contentDiv.innerHTML = ''
          contentDiv.appendChild(div)
          contentDiv.appendChild(loadingDiv)

          return promise.then(([choice, pin]) => {
            if (choice !== 'ok') throw new Error('cancelled by user')

            div.classList.add('d-none')
            loadingDiv.classList.remove('d-none')

            return signTransaction(network, address, tx, pin)
          })
        })
        .then(({ transactionBytes, transactionJSON, transactionFullHash }) => {
          contentDiv.innerHTML = ''
          contentDiv.appendChild(LoadingScreen(document, 'Posting Transaction'))
          // callback to the parent window with result
          const run = () =>
            callback(null, {
              transactionBytes,
              transactionJSON,
              transactionFullHash,
            })
          return pRetry(run, {
            retries: 5,
            factor: 1.71,
            onFailedAttempt: error => {
              contentDiv.innerHTML = ''
              contentDiv.appendChild(
                LoadingScreen(
                  document,
                  `Posting Transaction (attempt: ${error.attemptNumber})`,
                  `Error in Main App: ${error.message || error}`
                )
              )
            },
          })
        })
        .then(() => {
          const message =
            'Transaction Signed. Thank you for using our Open-source Vault. You will be returned to the main app.'
          const [div, promise] = SuccessScreen(document, 'Thank You', message, 2000)
          contentDiv.innerHTML = ''
          contentDiv.appendChild(div)
          return promise
        })
        .then(() => self.close()) // eslint-disable-line
        .catch(error => {
          // if (error.message !== 'cancelled by user' && error.message !== 'key missing') {
          //   window.alert(error.message || error) // eslint-disable-line
          // }

          // callback to the parent window on error
          callback(error)
            .then(() => {
              self.close() // eslint-disable-line
            })
            .catch(err => {
              window.alert(`Could not return error to parent window: ${err.message || err}`)
            })
        })
    }

    return Promise.reject(new Error('Received unknown action from parent window.'))
  }

  const appendStylesheet = href =>
    new Promise((resolve, reject) => {
      const linkElement = document.createElement('link')
      linkElement.type = 'text/css'
      linkElement.rel = 'stylesheet'
      linkElement.href = href
      linkElement.onload = resolve
      linkElement.onerror = reject
      document.head.appendChild(linkElement)
    })

  // On Load: Update key List
  updateKeyListDiv()
    .then(hasKeys => {
      // Create the welcome screen
      welcomeDiv = WelcomeScreen(document, hasKeys)

      if (!window.opener) {
        // Show welcome screen on startup
        contentDiv.appendChild(welcomeDiv)

        appendStylesheet('./css/main.default.css').then(() => {
          // Show the sidebar
          mainContent.classList.remove('offset-md-2')
          sidebarDiv.classList.remove('d-none')
          mainWrapper.classList.add('shadow-on')
        })
      } else {
        // Tell parent window vault is ready
        postRobot
          .send(window.opener, 'vaultReady', { version: '1.2.0' })
          .then(event => {
            // console.log(event.source, event.origin)
            // TODO: security checks on source/origin
            const {
              data: { style = 'EQH', action, params, callback },
            } = event

            if (style) {
              return appendStylesheet(`./css/main.${style.toLowerCase()}.css`).then(() =>
                triggerAction(action, params, callback)
              )
            }
            // else
            return triggerAction(action, params, callback)
          })
          .catch(error => {
            // Handle any errors that stopped our call from going through
            console.error('Trigger', error) // eslint-disable-line no-console
            contentDiv.textContent = `Problem with command sent from the main app. ${error}`
            setTimeout(() => window.close(), 5000)
          })
      }
    })
    .catch(error => {
      console.error('Internal', error) // eslint-disable-line no-console
      window.alert(`Internal ${error.message || error}. Please try again.`)
    })
}
