<?php
declare(strict_types=1);

namespace MageMinion\OrderExport\Model;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\Encryption\EncryptorInterface;
use Magento\Framework\HTTP\Client\CurlFactory;
use Psr\Log\LoggerInterface;

/**
 * POSTs one order to the ERP with a 2 s timeout and logs how long the call blocked.
 */
class Sender
{
    private const PATH = 'mageminion_order_export/general/';
    private const TIMEOUT_SECONDS = 2;

    /**
     * @param CurlFactory $curlFactory
     * @param ScopeConfigInterface $config
     * @param EncryptorInterface $encryptor
     * @param LoggerInterface $logger
     */
    public function __construct(
        private readonly CurlFactory $curlFactory,
        private readonly ScopeConfigInterface $config,
        private readonly EncryptorInterface $encryptor,
        private readonly LoggerInterface $logger
    ) {
    }

    /**
     * Whether the export is switched on in the configuration.
     *
     * @return bool
     */
    public function isEnabled(): bool
    {
        return $this->config->isSetFlag(self::PATH . 'enabled');
    }

    /**
     * Only orders whose customer email contains this text are exported (empty: all orders).
     *
     * @return string
     */
    public function emailFilter(): string
    {
        return trim((string)$this->config->getValue(self::PATH . 'test_email_filter'));
    }

    /**
     * Send one order. A 409 counts as accepted: the ERP has the order already.
     *
     * @param string $incrementId
     * @param string $json
     * @return void
     * @throws \Throwable when the ERP does not accept the order
     */
    public function post(string $incrementId, string $json): void
    {
        $status = 0;
        $error = '';
        $start = microtime(true);
        try {
            $url = rtrim((string)$this->config->getValue(self::PATH . 'url'), '/') . '/orders';
            // A new client per call: no options or headers of other callers leak in, and the key leaks out to no one.
            $curl = $this->curlFactory->create();
            $curl->setOptions([
                CURLOPT_TIMEOUT => self::TIMEOUT_SECONDS,
                CURLOPT_CONNECTTIMEOUT => self::TIMEOUT_SECONDS,
            ]);
            $curl->setHeaders([
                'Content-Type' => 'application/json',
                'Authorization' => 'Bearer '
                    . $this->encryptor->decrypt((string)$this->config->getValue(self::PATH . 'api_key')),
            ]);
            $curl->post($url, $json);
            $status = $curl->getStatus();
            if (($status < 200 || $status > 299) && $status !== 409) {
                throw new \RuntimeException('ERP returned ' . $status);
            }
        } catch (\Throwable $e) {
            $error = $e->getMessage();
            throw $e;
        } finally {
            try {
                $this->logger->info(sprintf(
                    'order %s status=%d ms=%.1f%s',
                    $incrementId,
                    $status,
                    (microtime(true) - $start) * 1000,
                    $error === '' ? '' : ' error=' . $error
                ));
            } catch (\Throwable) {
                // A broken log must not change the result of the send.
            }
        }
    }
}
